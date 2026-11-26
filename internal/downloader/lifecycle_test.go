package downloader

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCancelRunningCleansTemporaryFilesAndPreservesCompleted(t *testing.T) {
	for _, deleteFile := range []bool{false, true} {
		t.Run(fmt.Sprint("delete_", deleteFile), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodHead {
					w.WriteHeader(http.StatusMethodNotAllowed)
					return
				}
				if r.URL.Path == "/completed.bin" {
					_, _ = io.WriteString(w, "keep completed")
					return
				}
				_, _ = io.WriteString(w, "incomplete bytes")
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			}))
			t.Cleanup(server.Close)
			dir := t.TempDir()
			m := testManager(t, Config{MaxConcurrentFiles: 1})
			complete := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/completed.bin", dir))
			if complete.Status != StatusCompleted {
				t.Fatalf("completed setup: %+v", complete)
			}
			id := addTask(t, m, context.Background(), server.URL+"/running.bin", dir)
			eventually(t, "partial download bytes", func() bool { s, _ := m.Get(id); return s.Done > 0 })
			if err := m.Cancel(id, deleteFile); err != nil {
				t.Fatal(err)
			}
			if s := waitTask(t, m, id); s.Status != StatusCanceled {
				t.Errorf("Cancel status=%+v", s)
			}
			if err := m.Cancel(id, deleteFile); err != nil {
				t.Errorf("repeat Cancel=%v", err)
			}
			if err := m.Cancel(complete.ID, deleteFile); !errors.Is(err, ErrCompleted) {
				t.Errorf("Cancel completed=%v", err)
			}
			if err := m.CancelAll(); err != nil {
				t.Fatal(err)
			}
			assertFiles(t, dir, map[string][]byte{"completed.bin": []byte("keep completed")})
		})
	}
}

func TestCancelQueuedNeverStartsRequest(t *testing.T) {
	var hits atomic.Int32
	entered := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path == "/running.bin" {
			close(entered)
			<-r.Context().Done()
			return
		}
		_, _ = io.WriteString(w, "must not run")
	}))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	m := testManager(t, Config{MaxConcurrentFiles: 1})
	running := addTask(t, m, context.Background(), server.URL+"/running.bin", dir)
	select {
	case <-entered:
	case <-time.After(testTimeout):
		t.Fatal("first request not started")
	}
	queued := addTask(t, m, context.Background(), server.URL+"/queued.bin", dir)
	if s, _ := m.Get(queued); s.Status != StatusQueued {
		t.Fatalf("not queued: %+v", s)
	}
	if err := m.Cancel(queued, false); err != nil {
		t.Fatal(err)
	}
	if err := m.Cancel(running, false); err != nil {
		t.Fatal(err)
	}
	if s := waitTask(t, m, queued); s.Status != StatusCanceled || s.Done != 0 || s.SavePath != "" {
		t.Errorf("queued canceled snapshot=%+v", s)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	if err := m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 1 {
		t.Errorf("queued task reached server: requests=%d", hits.Load())
	}
	assertFiles(t, dir, nil)
}

func TestCancelAllCancelsRunningAndQueuedWithoutStartingQueue(t *testing.T) {
	const workers = 3
	entered := make(chan struct{}, workers+20)
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		hits.Add(1)
		entered <- struct{}{}
		_, _ = io.WriteString(w, "partial")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	m := testManager(t, Config{MaxConcurrentFiles: workers})
	var ids []TaskID
	for i := 0; i < workers; i++ {
		ids = append(ids, addTask(t, m, context.Background(), fmt.Sprintf("%s/%d.bin", server.URL, i), dir))
	}
	for i := 0; i < workers; i++ {
		select {
		case <-entered:
		case <-time.After(testTimeout):
			t.Fatal("running request not started")
		}
	}
	for i := workers; i < workers+20; i++ {
		ids = append(ids, addTask(t, m, context.Background(), fmt.Sprintf("%s/%d.bin", server.URL, i), dir))
	}
	if err := m.CancelAll(); err != nil {
		t.Fatal(err)
	}
	for i, id := range ids {
		s := waitTask(t, m, id)
		if s.Status != StatusCanceled {
			t.Errorf("task %d status=%+v", i, s)
		}
		if i >= workers && (s.SavePath != "" || s.Done != 0) {
			t.Errorf("queued task started: %+v", s)
		}
	}
	if hits.Load() != workers {
		t.Errorf("CancelAll started queued HTTP requests: hits=%d", hits.Load())
	}
	assertFiles(t, dir, nil)
}

func TestQueueCapacityRejectsOverflow(t *testing.T) {
	entered := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-r.Context().Done() }))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	m := testManager(t, Config{MaxConcurrentFiles: 1})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	running := addTask(t, m, ctx, server.URL+"/running.bin", dir)
	select {
	case <-entered:
	case <-time.After(testTimeout):
		t.Fatal("running request not started")
	}
	for i := 0; i < queueCapacity; i++ {
		addTask(t, m, context.Background(), server.URL+"/queued.bin", dir)
	}
	if _, err := m.Add(context.Background(), AddRequest{URL: server.URL + "/overflow.bin", SaveDir: dir}); !errors.Is(err, ErrQueueFull) {
		t.Errorf("full queue error=%v", err)
	}
	// Cancel queued entries before releasing the worker, so none can hit the server.
	if err := m.CancelAll(); err != nil {
		t.Fatal(err)
	}
	if s := waitTask(t, m, running); s.Status != StatusCanceled {
		t.Errorf("running status=%+v", s)
	}
	assertFiles(t, dir, nil)
}

func TestParentContextCancellationCleansRunningAndQueued(t *testing.T) {
	entered := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		close(entered)
		_, _ = io.WriteString(w, "partial")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	m := testManager(t, Config{MaxConcurrentFiles: 1})
	runCtx, cancelRunning := context.WithCancel(context.Background())
	defer cancelRunning()
	running := addTask(t, m, runCtx, server.URL+"/running.bin", dir)
	select {
	case <-entered:
	case <-time.After(testTimeout):
		t.Fatal("running request not started")
	}
	queueCtx, cancelQueued := context.WithCancel(context.Background())
	defer cancelQueued()
	queued := addTask(t, m, queueCtx, server.URL+"/queued.bin", dir)
	cancelQueued()
	if s := waitTask(t, m, queued); s.Status != StatusCanceled {
		t.Errorf("context canceled queued status=%+v", s)
	}
	cancelRunning()
	if s := waitTask(t, m, running); s.Status != StatusCanceled {
		t.Errorf("context canceled running status=%+v", s)
	}
	assertFiles(t, dir, nil)
}

func TestShutdownIdempotentWithoutEventConsumerAndBlockedHTTP(t *testing.T) {
	for _, sendHeaders := range []bool{false, true} {
		t.Run(fmt.Sprint("body_blocked_", sendHeaders), func(t *testing.T) {
			entered := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodHead {
					w.WriteHeader(http.StatusMethodNotAllowed)
					return
				}
				if sendHeaders {
					_, _ = io.WriteString(w, "partial")
					w.(http.Flusher).Flush()
				}
				close(entered)
				<-r.Context().Done()
			}))
			t.Cleanup(server.Close)
			dir := t.TempDir()
			m := testManager(t, Config{MaxConcurrentFiles: 1})
			ids := []TaskID{addTask(t, m, context.Background(), server.URL+"/running.bin", dir)}
			select {
			case <-entered:
			case <-time.After(testTimeout):
				t.Fatal("request not started")
			}
			for i := 0; i < 25; i++ {
				ids = append(ids, addTask(t, m, context.Background(), fmt.Sprintf("%s/%d.bin", server.URL, i), dir))
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			var wg sync.WaitGroup
			errs := make(chan error, 8)
			for i := 0; i < 8; i++ {
				wg.Add(1)
				go func() { defer wg.Done(); errs <- m.Shutdown(ctx) }()
			}
			wg.Wait()
			close(errs)
			for err := range errs {
				if err != nil {
					t.Errorf("Shutdown=%v", err)
				}
			}
			for _, id := range ids {
				if s := waitTask(t, m, id); s.Status != StatusCanceled {
					t.Errorf("shutdown task=%+v", s)
				}
			}
			for range m.Events() {
			}
			if err := m.Shutdown(ctx); err != nil {
				t.Errorf("repeat Shutdown=%v", err)
			}
			assertFiles(t, dir, nil)
		})
	}
}

func TestIdleTimeoutFailsAndCleansWithoutConsumer(t *testing.T) {
	for _, sendHeaders := range []bool{false, true} {
		t.Run(fmt.Sprint("body_idle_", sendHeaders), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodHead {
					w.WriteHeader(http.StatusMethodNotAllowed)
					return
				}
				if sendHeaders {
					_, _ = io.WriteString(w, "first chunk")
					w.(http.Flusher).Flush()
				}
				<-r.Context().Done()
			}))
			t.Cleanup(server.Close)
			dir := t.TempDir()
			m := testManager(t, Config{})
			// Configured before Add: workers cannot read idleTimeout before a task exists.
			m.idleTimeout = 80 * time.Millisecond
			s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/idle.bin", dir))
			if s.Status != StatusFailed || !strings.Contains(s.Error, errIdleTimeout.Error()) {
				t.Errorf("idle timeout snapshot=%+v", s)
			}
			assertFiles(t, dir, nil)
		})
	}
}

func TestDestinationAppearingDuringTransferIsPreserved(t *testing.T) {
	gate := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(gate) }) }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		_, _ = io.WriteString(w, "download start")
		w.(http.Flusher).Flush()
		select {
		case <-gate:
			_, _ = io.WriteString(w, "download end")
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(server.Close)
	defer release()
	dir := t.TempDir()
	m := testManager(t, Config{})
	id := addTask(t, m, context.Background(), server.URL+"/collision.bin", dir)
	eventually(t, "partial collision download", func() bool { s, _ := m.Get(id); return s.Done > 0 })
	s, _ := m.Get(id)
	if s.SavePath != filepath.Join(dir, "collision.bin") {
		t.Fatalf("unexpected destination=%q", s.SavePath)
	}
	if err := os.WriteFile(s.SavePath, []byte("external owner"), 0o600); err != nil {
		t.Fatal(err)
	}
	release()
	s = waitTask(t, m, id)
	if s.Status != StatusFailed || !strings.Contains(s.Error, "publish download") {
		t.Errorf("publication overwrote destination: %+v", s)
	}
	assertFiles(t, dir, map[string][]byte{"collision.bin": []byte("external owner")})
}

func TestIdleTimeoutResetsWhileBodyMakesProgress(t *testing.T) {
	const chunks = 24
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmt.Sprint(chunks))
		if r.Method == http.MethodHead {
			return
		}
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for i := 0; i < chunks; i++ {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				_, _ = io.WriteString(w, "x")
				w.(http.Flusher).Flush()
			}
		}
	}))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	m := testManager(t, Config{})
	m.idleTimeout = 200 * time.Millisecond
	s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/progress.bin", dir))
	if s.Status != StatusCompleted || s.Done != chunks {
		t.Errorf("progressing body hit an overall deadline: %+v", s)
	}
	assertFiles(t, dir, map[string][]byte{"progress.bin": []byte(strings.Repeat("x", chunks))})
}

func TestIdleTimeoutResetsAcrossPromptRedirects(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var hop int
		_, _ = fmt.Sscanf(r.URL.Path, "/hop%d", &hop)
		if hop < 4 {
			timer := time.NewTimer(90 * time.Millisecond)
			defer timer.Stop()
			select {
			case <-r.Context().Done():
				return
			case <-timer.C:
			}
			http.Redirect(w, r, fmt.Sprintf("/hop%d", hop+1), http.StatusFound)
			return
		}
		_, _ = io.WriteString(w, "redirect success")
	}))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	m := testManager(t, Config{})
	m.idleTimeout = 250 * time.Millisecond
	s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/hop0", dir))
	if s.Status != StatusCompleted {
		t.Fatalf("prompt redirect chain hit a total-duration idle deadline: %+v", s)
	}
	assertFiles(t, dir, map[string][]byte{"hop4": []byte("redirect success")})
}

func TestRedirectBodyDrainTracksProgressAndStalls(t *testing.T) {
	for _, stall := range []bool{false, true} {
		t.Run(fmt.Sprint("stalled_", stall), func(t *testing.T) {
			var finalHits atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodHead {
					w.WriteHeader(http.StatusMethodNotAllowed)
					return
				}
				if r.URL.Path == "/final.bin" {
					finalHits.Add(1)
					_, _ = io.WriteString(w, "final payload")
					return
				}
				w.Header().Set("Location", "/final.bin")
				w.Header().Set("Content-Length", "24")
				w.WriteHeader(http.StatusFound)
				_, _ = io.WriteString(w, "x")
				w.(http.Flusher).Flush()
				if stall {
					<-r.Context().Done()
					return
				}
				ticker := time.NewTicker(20 * time.Millisecond)
				defer ticker.Stop()
				for i := 1; i < 24; i++ {
					select {
					case <-r.Context().Done():
						return
					case <-ticker.C:
						_, _ = io.WriteString(w, "x")
						w.(http.Flusher).Flush()
					}
				}
			}))
			t.Cleanup(server.Close)
			dir := t.TempDir()
			m := testManager(t, Config{})
			m.idleTimeout = 200 * time.Millisecond
			s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/redirect", dir))
			if stall {
				if s.Status != StatusFailed || !strings.Contains(s.Error, errIdleTimeout.Error()) || finalHits.Load() != 0 {
					t.Errorf("stalled redirect drain escaped timeout: %+v, finalHits=%d", s, finalHits.Load())
				}
				assertFiles(t, dir, nil)
			} else {
				if s.Status != StatusCompleted || finalHits.Load() != 1 {
					t.Errorf("progressing redirect drain failed: %+v, finalHits=%d", s, finalHits.Load())
				}
				assertFiles(t, dir, map[string][]byte{"final.bin": []byte("final payload")})
			}
		})
	}
}

func TestConcurrentCancelAndCompletionKeepPublishedFiles(t *testing.T) {
	payload := strings.Repeat("publication racing cancellation\n", 1000)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, payload) }))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	m := testManager(t, Config{MaxConcurrentFiles: 10})
	const count = 40
	ids := make([]TaskID, count)
	for i := range ids {
		ids[i] = addTask(t, m, context.Background(), fmt.Sprintf("%s/race-%d.bin", server.URL, i), dir)
	}
	var wg sync.WaitGroup
	errs := make(chan error, count)
	for _, id := range ids {
		wg.Add(1)
		go func(id TaskID) { defer wg.Done(); errs <- m.Cancel(id, true) }(id)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil && !errors.Is(err, ErrCompleted) {
			t.Errorf("racing Cancel=%v", err)
		}
	}
	want := make(map[string][]byte)
	for _, id := range ids {
		s := waitTask(t, m, id)
		switch s.Status {
		case StatusCompleted:
			want[s.FileName] = []byte(payload)
		case StatusCanceled:
		default:
			t.Errorf("unexpected cancel/publication outcome: %+v", s)
		}
	}
	if err := m.CancelAll(); err != nil {
		t.Fatal(err)
	}
	assertFiles(t, dir, want)
}

func TestShutdownDeadlineThenSuccessfulRetry(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		close(entered)
		<-release
		return nil, r.Context().Err()
	})}
	dir := t.TempDir()
	m := testManager(t, Config{Client: client})
	id := addTask(t, m, context.Background(), "https://example.invalid/blocked.bin", dir)
	select {
	case <-entered:
	case <-time.After(testTimeout):
		t.Fatal("transport did not start")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := m.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Shutdown blocked past deadline or returned wrong error: %v", err)
	}
	unblock()
	ctx2, cancel2 := context.WithTimeout(context.Background(), testTimeout)
	defer cancel2()
	if err := m.Shutdown(ctx2); err != nil {
		t.Errorf("Shutdown retry: %v", err)
	}
	if s := waitTask(t, m, id); s.Status != StatusCanceled {
		t.Errorf("shutdown task status=%+v", s)
	}
	assertFiles(t, dir, nil)
}
