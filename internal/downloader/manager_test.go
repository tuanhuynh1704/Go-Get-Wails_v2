package downloader

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.uber.org/goleak"
)

func TestMain(m *testing.M) { goleak.VerifyTestMain(m) }

const testTimeout = 5 * time.Second

func testManager(t *testing.T, cfg Config) *Manager {
	t.Helper()
	m := NewManager(cfg)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
		defer cancel()
		if err := m.Shutdown(ctx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
		if cfg.Client != nil {
			cfg.Client.CloseIdleConnections()
		}
	})
	return m
}

func addTask(t *testing.T, m *Manager, ctx context.Context, rawURL, dir string) TaskID {
	t.Helper()
	id, err := m.Add(ctx, AddRequest{URL: rawURL, SaveDir: dir})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	return id
}

func waitTask(t *testing.T, m *Manager, id TaskID) TaskSnapshot {
	t.Helper()
	m.mu.Lock()
	task := m.tasks[id]
	m.mu.Unlock()
	if task == nil {
		t.Fatalf("task %q missing", id)
	}
	select {
	case <-task.finished:
	case <-time.After(testTimeout):
		s, _ := m.Get(id)
		t.Fatalf("task did not finish: %+v", s)
	}
	s, ok := m.Get(id)
	if !ok {
		t.Fatal("finished task missing")
	}
	return s
}

func eventually(t *testing.T, description string, condition func() bool) {
	t.Helper()
	ticker := time.NewTicker(2 * time.Millisecond)
	defer ticker.Stop()
	timer := time.NewTimer(testTimeout)
	defer timer.Stop()
	for {
		if condition() {
			return
		}
		select {
		case <-ticker.C:
		case <-timer.C:
			t.Fatalf("timed out waiting for %s", description)
		}
	}
}

func assertFiles(t *testing.T, dir string, want map[string][]byte) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != len(want) {
		t.Errorf("directory entries = %v; want %d files", entries, len(want))
	}
	for _, entry := range entries {
		expected, ok := want[entry.Name()]
		if !ok {
			t.Errorf("unexpected file %q (temporary files must be cleaned)", entry.Name())
			continue
		}
		got, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil || !bytes.Equal(got, expected) {
			t.Errorf("file %q: content mismatch, error %v", entry.Name(), err)
		}
	}
}

func TestDownloadSHA256KnownUnknownAndEmpty(t *testing.T) {
	payload := bytes.Repeat([]byte("GoGet integrity\x00\xff\n"), 19000)
	for _, tc := range []struct {
		name    string
		body    []byte
		unknown bool
	}{
		{"known", payload, false},
		{"unknown", payload, true},
		{"empty", nil, false},
		{"empty_unknown", nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			requests := make(chan *http.Request, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests <- r.Clone(context.Background())
				if tc.unknown {
					w.WriteHeader(http.StatusOK)
					w.(http.Flusher).Flush()
				} else {
					w.Header().Set("Content-Length", fmt.Sprint(len(tc.body)))
				}
				_, _ = w.Write(tc.body)
			}))
			t.Cleanup(server.Close)
			dir := t.TempDir()
			m := testManager(t, Config{})
			s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/payload.bin", dir))
			if s.Status != StatusCompleted || s.Error != "" || s.Done != int64(len(tc.body)) {
				t.Fatalf("unexpected terminal snapshot: %+v", s)
			}
			wantTotal := int64(len(tc.body))
			if tc.unknown {
				wantTotal = -1
			}
			if s.Total != wantTotal {
				t.Errorf("Total = %d, want %d", s.Total, wantTotal)
			}
			got, err := os.ReadFile(s.SavePath)
			if err != nil || sha256.Sum256(got) != sha256.Sum256(tc.body) {
				t.Fatalf("download SHA256 mismatch: %v", err)
			}
			assertFiles(t, dir, map[string][]byte{"payload.bin": tc.body})
			r := <-requests
			if r.Method != http.MethodGet || r.Header.Get("Range") != "" || r.Header.Get("Accept-Encoding") != "identity" || r.UserAgent() != "GoGet/0.1" {
				t.Errorf("unexpected single-stream request: %s %v", r.Method, r.Header)
			}
		})
	}
}

func TestDownloadRejectsHTTPTruncationAndEncoding(t *testing.T) {
	for _, tc := range []struct {
		name      string
		code      int
		encoding  string
		truncated bool
		wantError string
	}{
		{"not_found", 404, "", false, "HTTP 404"},
		{"server_error", 503, "", false, "HTTP 503"},
		{"unsolicited_partial", 206, "", false, "HTTP 206"},
		{"truncated", 200, "", true, "unexpected EOF"},
		{"gzip", 200, "gzip", false, "unsupported Content-Encoding"},
		{"unknown_encoding", 200, "not-an-encoding", false, "unsupported Content-Encoding"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.truncated {
					w.Header().Set("Content-Length", "1000")
				}
				if tc.encoding != "" {
					w.Header().Set("Content-Encoding", tc.encoding)
				}
				w.WriteHeader(tc.code)
				_, _ = io.WriteString(w, "partial payload")
			}))
			t.Cleanup(server.Close)
			dir := t.TempDir()
			m := testManager(t, Config{})
			s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/failed.bin", dir))
			if s.Status != StatusFailed || !strings.Contains(s.Error, tc.wantError) {
				t.Errorf("snapshot = %+v, want failed with %q", s, tc.wantError)
			}
			assertFiles(t, dir, nil)
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type brokenBody struct {
	sent   bool
	closed atomic.Bool
}

func (b *brokenBody) Read(p []byte) (int, error) {
	if !b.sent {
		b.sent = true
		return copy(p, "bytes before read failure"), errors.New("injected read failure")
	}
	return 0, io.EOF
}

func (b *brokenBody) Close() error { b.closed.Store(true); return nil }

func TestCustomTransportNilRequestAndReadFailure(t *testing.T) {
	for _, broken := range []bool{false, true} {
		t.Run(fmt.Sprint("read_error_", broken), func(t *testing.T) {
			bad := &brokenBody{}
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				var body io.ReadCloser = io.NopCloser(strings.NewReader("custom transport payload"))
				if broken {
					body = bad
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: body, ContentLength: -1, Request: nil}, nil
			})}
			dir := t.TempDir()
			m := testManager(t, Config{Client: client})
			s := waitTask(t, m, addTask(t, m, context.Background(), "https://example.invalid/custom.bin", dir))
			if broken {
				if s.Status != StatusFailed || !strings.Contains(s.Error, "injected read failure") || !bad.closed.Load() {
					t.Errorf("read error or body closure lost: %+v, closed=%v", s, bad.closed.Load())
				}
				assertFiles(t, dir, nil)
			} else {
				if s.Status != StatusCompleted || s.FileName != "custom.bin" {
					t.Fatalf("nil Request response: %+v", s)
				}
				assertFiles(t, dir, map[string][]byte{"custom.bin": []byte("custom transport payload")})
			}
		})
	}
}

func TestConcurrentFileLimitAndClamp(t *testing.T) {
	for _, tc := range []struct{ configured, want int }{{-1, 3}, {1, 1}, {3, 3}, {99, 10}} {
		t.Run(fmt.Sprintf("configured_%d", tc.configured), func(t *testing.T) {
			gate := make(chan struct{})
			var once sync.Once
			release := func() { once.Do(func() { close(gate) }) }
			entered := make(chan struct{}, tc.want+3)
			var active, peak atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := active.Add(1)
				defer active.Add(-1)
				for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
				}
				entered <- struct{}{}
				select {
				case <-gate:
					_, _ = io.WriteString(w, "bounded")
				case <-r.Context().Done():
				}
			}))
			t.Cleanup(server.Close)
			defer release()
			m := testManager(t, Config{MaxConcurrentFiles: tc.configured})
			dir := t.TempDir()
			var ids []TaskID
			for i := 0; i < tc.want+3; i++ {
				ids = append(ids, addTask(t, m, context.Background(), fmt.Sprintf("%s/%d.bin", server.URL, i), dir))
			}
			for i := 0; i < tc.want; i++ {
				select {
				case <-entered:
				case <-time.After(testTimeout):
					t.Fatal("workers failed to fill configured concurrency")
				}
			}
			queued := 0
			for _, s := range m.Snapshot() {
				if s.Status == StatusQueued {
					queued++
				}
			}
			if queued != 3 || peak.Load() != int32(tc.want) {
				t.Errorf("queued=%d peak=%d, want queued=3 peak=%d", queued, peak.Load(), tc.want)
			}
			release()
			for _, id := range ids {
				if s := waitTask(t, m, id); s.Status != StatusCompleted {
					t.Errorf("task failed: %+v", s)
				}
			}
			if peak.Load() > int32(tc.want) {
				t.Errorf("concurrency exceeded bound: %d > %d", peak.Load(), tc.want)
			}
		})
	}
}

func TestDuplicateURLsPreserveExistingFiles(t *testing.T) {
	const count = 16
	payload := bytes.Repeat([]byte("duplicate URL\x00"), 1000)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	want := map[string][]byte{"payload.bin": []byte("original"), "payload (1).bin.goget": []byte("unrelated partial")}
	for name, content := range want {
		if err := os.WriteFile(filepath.Join(dir, name), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	m := testManager(t, Config{MaxConcurrentFiles: 10})
	var ids []TaskID
	for i := 0; i < count; i++ {
		ids = append(ids, addTask(t, m, context.Background(), server.URL+"/payload.bin", dir))
	}
	for _, id := range ids {
		s := waitTask(t, m, id)
		if s.Status != StatusCompleted {
			t.Fatalf("duplicate failed: %+v", s)
		}
		if _, exists := want[s.FileName]; exists {
			t.Fatalf("duplicate target %q", s.FileName)
		}
		want[s.FileName] = payload
	}
	assertFiles(t, dir, want)
}

func TestTLSRedirectDowngradeRejectedWithoutMutatingClient(t *testing.T) {
	var insecureHits atomic.Int32
	insecure := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		insecureHits.Add(1)
		_, _ = io.WriteString(w, "insecure")
	}))
	t.Cleanup(insecure.Close)
	secure := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, insecure.URL+"/payload.bin", http.StatusFound)
	}))
	t.Cleanup(secure.Close)
	client := secure.Client()
	var callerRedirects atomic.Int32
	client.CheckRedirect = func(r *http.Request, via []*http.Request) error { callerRedirects.Add(1); return nil }
	dir := t.TempDir()
	m := testManager(t, Config{Client: client})
	s := waitTask(t, m, addTask(t, m, context.Background(), secure.URL+"/secure.bin", dir))
	if s.Status != StatusFailed || !strings.Contains(s.Error, "cannot downgrade") || insecureHits.Load() != 0 || callerRedirects.Load() != 0 {
		t.Errorf("downgrade not refused: %+v, insecureHits=%d, callerRedirects=%d", s, insecureHits.Load(), callerRedirects.Load())
	}
	assertFiles(t, dir, nil)
	resp, err := client.Get(secure.URL + "/caller.bin")
	if err != nil {
		t.Fatalf("manager changed caller's redirect policy: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if insecureHits.Load() != 1 || callerRedirects.Load() != 1 {
		t.Error("caller redirect hook was replaced")
	}
}

func TestRedirectFilenameAndCallerPolicy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			http.Redirect(w, r, "/final.bin", http.StatusFound)
			return
		}
		_, _ = io.WriteString(w, "redirected bytes")
	}))
	t.Cleanup(server.Close)
	for _, reject := range []bool{false, true} {
		t.Run(fmt.Sprint("reject_", reject), func(t *testing.T) {
			client := server.Client()
			var called atomic.Int32
			client.CheckRedirect = func(r *http.Request, via []*http.Request) error {
				called.Add(1)
				if reject {
					return errors.New("caller refuses redirect")
				}
				return nil
			}
			dir := t.TempDir()
			m := testManager(t, Config{Client: client})
			s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/start", dir))
			if called.Load() != 1 {
				t.Errorf("caller redirect count=%d", called.Load())
			}
			if reject {
				if s.Status != StatusFailed || !strings.Contains(s.Error, "caller refuses redirect") {
					t.Errorf("caller redirect failure lost: %+v", s)
				}
				assertFiles(t, dir, nil)
			} else {
				if s.Status != StatusCompleted || s.FileName != "final.bin" {
					t.Errorf("final URL filename missing: %+v", s)
				}
				assertFiles(t, dir, map[string][]byte{"final.bin": []byte("redirected bytes")})
			}
		})
	}
}

func TestAddRejectsInvalidRequestsAndClosedManager(t *testing.T) {
	m := testManager(t, Config{MaxConcurrentFiles: 1})
	dir := t.TempDir()
	file := filepath.Join(dir, "not-directory")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	for _, tc := range []struct {
		name     string
		ctx      context.Context
		url, dir string
	}{
		{"nil_context", nil, "https://example.invalid/a", dir},
		{"canceled_context", canceled, "https://example.invalid/a", dir},
		{"relative_url", context.Background(), "/relative", dir},
		{"ftp", context.Background(), "ftp://example.invalid/a", dir},
		{"empty_host", context.Background(), "https:///a", dir},
		{"malformed", context.Background(), "http://%zz/a", dir},
		{"line_break", context.Background(), "https://example.invalid/a\r\nX: injected", dir},
		{"relative_dir", context.Background(), "https://example.invalid/a", "."},
		{"missing_dir", context.Background(), "https://example.invalid/a", filepath.Join(dir, "missing")},
		{"file_dir", context.Background(), "https://example.invalid/a", file},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if id, err := m.Add(tc.ctx, AddRequest{URL: tc.url, SaveDir: tc.dir}); err == nil || id != "" {
				t.Errorf("invalid request accepted: id=%q error=%v", id, err)
			}
		})
	}
	if len(m.Snapshot()) != 0 {
		t.Error("invalid requests changed task list")
	}
	if _, ok := m.Get("missing"); ok {
		t.Error("Get found unknown task")
	}
	if err := m.Cancel("missing", true); !errors.Is(err, ErrNotFound) {
		t.Errorf("Cancel unknown=%v", err)
	}
	ctx, stop := context.WithTimeout(context.Background(), testTimeout)
	defer stop()
	if err := m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Add(context.Background(), AddRequest{URL: "https://example.invalid/a", SaveDir: dir}); !errors.Is(err, ErrClosed) {
		t.Errorf("Add after Shutdown=%v", err)
	}
}

func TestEventOrderProgressAndSnapshotIsolation(t *testing.T) {
	gate := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(gate) }) }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "6")
		_, _ = io.WriteString(w, "abc")
		w.(http.Flusher).Flush()
		select {
		case <-gate:
			_, _ = io.WriteString(w, "def")
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(server.Close)
	defer release()
	m := testManager(t, Config{})
	dir := t.TempDir()
	id := addTask(t, m, context.Background(), server.URL+"/events.bin", dir)
	var statuses []Status
	var added Event
	var previous int64
	progressSeen := false
	timer := time.NewTimer(testTimeout)
	defer timer.Stop()
	for {
		select {
		case event := <-m.Events():
			if event.Task.ID != id {
				t.Fatalf("unexpected event: %+v", event)
			}
			if event.Task.Done < previous {
				t.Errorf("Done regressed from %d to %d", previous, event.Task.Done)
			}
			previous = event.Task.Done
			switch event.Kind {
			case EvAdded:
				added = event
				if len(statuses) != 0 || event.Task.Status != StatusQueued || event.Task.Total != -1 {
					t.Errorf("bad added event: %+v", event)
				}
				statuses = append(statuses, event.Task.Status)
			case EvStatus:
				statuses = append(statuses, event.Task.Status)
			case EvProgress:
				if event.Task.Status != StatusDownloading || event.Task.Done != 3 || event.Task.Total != 6 {
					t.Errorf("bad progress: %+v", event)
				}
				progressSeen = true
				release()
			}
			if event.Task.Status == StatusCompleted {
				want := []Status{StatusQueued, StatusProbing, StatusDownloading, StatusCompleted}
				if !reflect.DeepEqual(statuses, want) || !progressSeen {
					t.Errorf("statuses=%v progress=%v, want %v", statuses, progressSeen, want)
				}
				if added.Task.Status != StatusQueued || added.Task.Done != 0 {
					t.Error("earlier event snapshot mutated")
				}
				if event.Task.Done != 6 || event.Task.Total != 6 {
					t.Errorf("bad completion: %+v", event.Task)
				}
				snapshots := m.Snapshot()
				snapshots[0].Status, snapshots[0].FileName = StatusFailed, "mutated"
				current, _ := m.Get(id)
				if current.Status != StatusCompleted || current.FileName != "events.bin" {
					t.Error("Snapshot exposes mutable task state")
				}
				return
			}
		case <-timer.C:
			t.Fatalf("event stream stalled: statuses=%v progress=%v", statuses, progressSeen)
		}
	}
}

func TestRedirectLimitStopsLoopAndCleans(t *testing.T) {
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Redirect(w, r, "/again", http.StatusFound)
	}))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	m := testManager(t, Config{})
	s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/again", dir))
	if s.Status != StatusFailed || !strings.Contains(s.Error, "stopped after 10 redirects") || hits.Load() != 10 {
		t.Errorf("redirect loop not bounded: %+v, hits=%d", s, hits.Load())
	}
	assertFiles(t, dir, nil)
}

func TestCustomTransportLengthMismatchAndRequestError(t *testing.T) {
	for _, tc := range []struct {
		name           string
		length         int64
		transportError bool
		want           string
	}{
		{"short_body", 100, false, "incomplete response"},
		{"long_body", 1, false, "incomplete response"},
		{"request_error", 0, true, "injected transport failure"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if tc.transportError {
					return nil, errors.New("injected transport failure")
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("payload")), ContentLength: tc.length}, nil
			})}
			dir := t.TempDir()
			m := testManager(t, Config{Client: client})
			s := waitTask(t, m, addTask(t, m, context.Background(), "https://example.invalid/failed.bin", dir))
			if s.Status != StatusFailed || !strings.Contains(s.Error, tc.want) {
				t.Errorf("length/transport failure lost: %+v", s)
			}
			assertFiles(t, dir, nil)
		})
	}
}
