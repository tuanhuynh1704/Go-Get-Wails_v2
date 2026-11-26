package downloader

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testPayload(size int) []byte {
	data := make([]byte, size)
	for i := range data {
		data[i] = byte((i*31 + i/257) % 251)
	}
	return data
}

func testRange(t *testing.T, r *http.Request, total int) (int, int) {
	t.Helper()
	value := strings.TrimPrefix(r.Header.Get("Range"), "bytes=")
	left, right, ok := strings.Cut(value, "-")
	start, e1 := strconv.Atoi(left)
	end, e2 := strconv.Atoi(right)
	if !ok || e1 != nil || e2 != nil || start < 0 || end < start || end >= total {
		t.Errorf("invalid request Range: %q", r.Header.Get("Range"))
		return 0, 0
	}
	return start, end
}

func rangeHeaders(w http.ResponseWriter, total int) {
	w.Header().Set("Content-Length", strconv.Itoa(total))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("ETag", `"version-one"`)
}

func writeTestRange(w http.ResponseWriter, payload []byte, start, end int) {
	w.Header().Set("Content-Length", strconv.Itoa(end-start+1))
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
	w.WriteHeader(http.StatusPartialContent)
	_, _ = w.Write(payload[start : end+1])
}

func TestSplitBoundariesAndOverflow(t *testing.T) {
	for _, total := range []int64{1, minSegmentSize - 1, minSegmentSize, minSegmentSize + 1, 2 * minSegmentSize, 32*minSegmentSize + 7, math.MaxInt64} {
		for _, requested := range []int{1, 2, 8, 32} {
			t.Run(fmt.Sprintf("%d_%d", total, requested), func(t *testing.T) {
				segments := split(total, requested)
				want := min(int64(requested), (total-1)/minSegmentSize+1)
				if int64(len(segments)) != want {
					t.Fatalf("count=%d want=%d", len(segments), want)
				}
				var cursor, sum int64
				for i, segment := range segments {
					if segment.Index != i || segment.Start != cursor || segment.End < segment.Start || segment.End >= total {
						t.Fatalf("gap, overlap, or invalid boundary: %+v cursor=%d", segment, cursor)
					}
					sum += segment.End - segment.Start + 1
					cursor = segment.End + 1
				}
				if sum != total || cursor != total {
					t.Fatalf("covered %d, end %d, want %d", sum, cursor, total)
				}
			})
		}
	}
	for _, total := range []int64{-1, 0} {
		if len(split(total, 8)) != 0 || segmentCount(total, 8) != 1 {
			t.Errorf("nonpositive split total=%d", total)
		}
	}
}

func TestSegmentedDownloadSHA256AndExactCoverage(t *testing.T) {
	payload := testPayload(8*1024*1024 + 173)
	for _, requested := range []int{0, 3, 32} {
		t.Run(fmt.Sprint("requested_", requested), func(t *testing.T) {
			wantCount := requested
			if wantCount == 0 {
				wantCount = 8
			}
			wantCount = min(wantCount, 9)
			var rangesMu sync.Mutex
			var ranges [][2]int
			var heads, probes, fulls atomic.Int32
			gate := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				rangeHeaders(w, len(payload))
				if r.Header.Get("Accept-Encoding") != "identity" || r.UserAgent() != "GoGet/0.2" {
					t.Errorf("unsafe request headers: %v", r.Header)
				}
				if r.Method == http.MethodHead {
					heads.Add(1)
					return
				}
				if r.Header.Get("Range") == "" {
					fulls.Add(1)
					_, _ = w.Write(payload)
					return
				}
				if r.Header.Get("If-Range") != `"version-one"` {
					t.Errorf("missing strong If-Range: %q", r.Header.Get("If-Range"))
				}
				start, end := testRange(t, r, len(payload))
				if start == 0 && end == 0 {
					probes.Add(1)
				} else {
					rangesMu.Lock()
					ranges = append(ranges, [2]int{start, end})
					if len(ranges) == wantCount {
						close(gate)
					}
					rangesMu.Unlock()
					select {
					case <-gate:
					case <-r.Context().Done():
						return
					}
				}
				writeTestRange(w, payload, start, end)
			}))
			t.Cleanup(server.Close)
			dir := t.TempDir()
			m := testManager(t, Config{})
			id, err := m.Add(context.Background(), AddRequest{URL: server.URL + "/parallel.bin", SaveDir: dir, Segments: requested})
			if err != nil {
				t.Fatal(err)
			}
			s := waitTask(t, m, id)
			if s.Status != StatusCompleted || s.Error != "" || s.Total != int64(len(payload)) || s.Done != s.Total || s.Speed != 0 || s.EtaSec != 0 || !s.Resumable || s.SegCount != wantCount {
				t.Fatalf("bad completion: %+v", s)
			}
			rangesMu.Lock()
			count := len(ranges)
			rangesMu.Unlock()
			if heads.Load() != 1 || probes.Load() != 1 || fulls.Load() != 0 || count != wantCount {
				t.Fatalf("HEAD=%d probe=%d full=%d workers=%d", heads.Load(), probes.Load(), fulls.Load(), count)
			}
			var cursor int64
			for i, segment := range s.Segments {
				if segment.Index != i || segment.Start != cursor || segment.Done != segment.End-segment.Start+1 || segment.Status != string(StatusCompleted) || s.Segs[i] != 100 {
					t.Errorf("bad terminal segment %d: %+v, percent=%d", i, segment, s.Segs[i])
				}
				cursor = segment.End + 1
			}
			got, err := os.ReadFile(s.SavePath)
			if err != nil || sha256.Sum256(got) != sha256.Sum256(payload) {
				t.Fatalf("parallel SHA256 mismatch: %v", err)
			}
		})
	}
}

func TestIgnoredRangeJoinsWorkersAndRestartsFreshRepresentation(t *testing.T) {
	old := bytes.Repeat([]byte("a"), 2*1024*1024)
	fresh := bytes.Repeat([]byte("b"), 2*1024*1024+177)
	ignore := make(chan struct{})
	var release sync.Once
	unblock := func() { release.Do(func() { close(ignore) }) }
	defer unblock()
	var active, fulls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rangeHeaders(w, len(old))
		if r.Method == http.MethodHead {
			return
		}
		if r.Header.Get("Range") == "" {
			fulls.Add(1)
			if r.Header.Get("If-Range") != "" {
				t.Error("single restart retained If-Range")
			}
			w.Header().Set("ETag", `"version-two"`)
			w.Header().Set("Content-Length", strconv.Itoa(len(fresh)))
			_, _ = w.Write(fresh)
			return
		}
		start, end := testRange(t, r, len(old))
		if end == 0 {
			writeTestRange(w, old, 0, 0)
			return
		}
		active.Add(1)
		defer active.Add(-1)
		if start == 0 {
			w.Header().Set("Content-Length", strconv.Itoa(end+1))
			w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", end, len(old)))
			w.WriteHeader(http.StatusPartialContent)
			_, _ = w.Write(old[:64*1024])
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		select {
		case <-ignore:
			// A different representation and size must never be mixed with old
			// bytes, even though some old ranges have already reached the disk.
			w.Header().Set("Content-Length", strconv.Itoa(len(fresh)))
			w.Header().Set("ETag", `"version-two"`)
			_, _ = w.Write(fresh)
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	m := testManager(t, Config{SegmentsPerFile: 2})
	id := addTask(t, m, context.Background(), server.URL+"/restart.bin", dir)
	eventually(t, "old range bytes written", func() bool { s, _ := m.Get(id); return s.Done > 0 && active.Load() == 2 })
	unblock()
	s := waitTask(t, m, id)
	if s.Status != StatusCompleted || s.SegCount != 1 || s.Resumable || s.Done != int64(len(fresh)) || s.Total != s.Done || fulls.Load() != 1 || s.Segs[0] != 100 {
		t.Fatalf("bad safe restart: %+v, full GETs=%d", s, fulls.Load())
	}
	got, err := os.ReadFile(s.SavePath)
	if err != nil || sha256.Sum256(got) != sha256.Sum256(fresh) {
		t.Fatalf("restart mixed representations: %v", err)
	}
	eventually(t, "canceled range handlers exit", func() bool { return active.Load() == 0 })
	// Ordered snapshots must include the progress reset before the single GET.
	var sawOld, sawReset bool
	for {
		select {
		case e := <-m.Events():
			if e.Task.SegCount == 2 {
				sawOld = true
			}
			if sawOld && e.Kind == EvStatus && e.Task.SegCount == 1 && e.Task.Done == 0 {
				sawReset = true
			}
			if e.Task.Status == StatusCompleted {
				if !sawReset {
					t.Error("fallback progress reset was not published")
				}
				return
			}
		case <-time.After(testTimeout):
			t.Fatal("missing completion event")
		}
	}
}

func TestSegmentResponseIntegrityFailuresCleanAllFiles(t *testing.T) {
	payload := testPayload(2 * 1024 * 1024)
	for _, kind := range []string{"start", "end", "total", "missing_range", "length", "validator", "missing_validator", "weak_validator", "encoding", "truncated", "oversized"} {
		t.Run(kind, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				rangeHeaders(w, len(payload))
				if r.Method == http.MethodHead {
					return
				}
				start, end := testRange(t, r, len(payload))
				if end == 0 {
					writeTestRange(w, payload, start, end)
					return
				}
				w.Header().Set("Content-Length", strconv.Itoa(end-start+1))
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
				switch kind {
				case "start":
					w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start+1, end, len(payload)))
				case "end":
					w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end-1, len(payload)))
				case "total":
					w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)+1))
				case "missing_range":
					w.Header().Del("Content-Range")
				case "length":
					w.Header().Set("Content-Length", "1")
				case "validator":
					w.Header().Set("ETag", `"version-two"`)
				case "missing_validator":
					w.Header().Del("ETag")
				case "weak_validator":
					w.Header().Set("ETag", `W/"version-one"`)
				case "encoding":
					w.Header().Set("Content-Encoding", "gzip")
				case "oversized":
					w.Header().Del("Content-Length")
				}
				w.WriteHeader(http.StatusPartialContent)
				if kind == "truncated" {
					_, _ = w.Write(payload[start : start+127])
					return
				}
				if kind == "oversized" {
					w.(http.Flusher).Flush()
				}
				_, _ = w.Write(payload[start : end+1])
				if kind == "oversized" {
					_, _ = w.Write([]byte{99})
				}
			}))
			t.Cleanup(server.Close)
			m := testManager(t, Config{SegmentsPerFile: 2})
			dir := t.TempDir()
			s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/bad.bin", dir))
			if s.Status != StatusFailed || s.Error == "" || s.Speed != 0 || s.EtaSec != -1 {
				t.Fatalf("invalid segment accepted: %+v", s)
			}
			want := "Content-Range"
			switch kind {
			case "length":
				want = "Content-Length"
			case "validator", "missing_validator", "weak_validator":
				want = "validator"
			case "encoding":
				want = "Content-Encoding"
			case "truncated":
				want = "unexpected EOF"
			case "oversized":
				want = "exceeds expected length"
			}
			if !strings.Contains(s.Error, want) {
				t.Errorf("error=%q want %q", s.Error, want)
			}
			assertFiles(t, dir, nil)
		})
	}
}

func TestEachSegmentHasIndependentIdleWatchdog(t *testing.T) {
	for _, headers := range []bool{false, true} {
		t.Run(fmt.Sprint("headers_", headers), func(t *testing.T) {
			payload := testPayload(2 * 1024 * 1024)
			var active, busyChunks atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				rangeHeaders(w, len(payload))
				if r.Method == http.MethodHead {
					return
				}
				start, end := testRange(t, r, len(payload))
				if end == 0 {
					writeTestRange(w, payload, start, end)
					return
				}
				active.Add(1)
				defer active.Add(-1)
				if start == 0 && !headers {
					<-r.Context().Done()
					return
				}
				w.Header().Set("Content-Length", strconv.Itoa(end-start+1))
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
				w.WriteHeader(http.StatusPartialContent)
				w.(http.Flusher).Flush()
				if start == 0 {
					<-r.Context().Done()
					return
				}
				ticker := time.NewTicker(10 * time.Millisecond)
				defer ticker.Stop()
				for {
					select {
					case <-r.Context().Done():
						return
					case <-ticker.C:
						if _, err := w.Write([]byte{1}); err != nil {
							return
						}
						busyChunks.Add(1)
						w.(http.Flusher).Flush()
					}
				}
			}))
			t.Cleanup(server.Close)
			m := testManager(t, Config{SegmentsPerFile: 2})
			m.idleTimeout = 150 * time.Millisecond
			dir := t.TempDir()
			s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/stalled.bin", dir))
			if s.Status != StatusFailed || !strings.Contains(s.Error, errIdleTimeout.Error()) || busyChunks.Load() < 2 {
				t.Fatalf("busy sibling masked stall: %+v, busy reads=%d", s, busyChunks.Load())
			}
			eventually(t, "all stalled task handlers stop", func() bool { return active.Load() == 0 })
			assertFiles(t, dir, nil)
		})
	}
}

func TestCancelParallelWorkersAndConcurrentSnapshotReaders(t *testing.T) {
	payload := testPayload(4 * 1024 * 1024)
	var active atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rangeHeaders(w, len(payload))
		if r.Method == http.MethodHead {
			return
		}
		start, end := testRange(t, r, len(payload))
		if end == 0 {
			writeTestRange(w, payload, start, end)
			return
		}
		active.Add(1)
		defer active.Add(-1)
		w.Header().Set("Content-Length", strconv.Itoa(end-start+1))
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(payload)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(payload[start : start+4096])
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(server.Close)
	m := testManager(t, Config{SegmentsPerFile: 4})
	dir := t.TempDir()
	id := addTask(t, m, context.Background(), server.URL+"/cancel.bin", dir)
	eventually(t, "all four workers downloading", func() bool { s, _ := m.Get(id); return active.Load() == 4 && s.Done >= 4*4096 })
	stopReaders := make(chan struct{})
	var readers sync.WaitGroup
	for i := 0; i < 8; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stopReaders:
					return
				default:
				}
				s, _ := m.Get(id)
				s.Segs[0], s.Segments[0].Done = -1, -1
				all := m.Snapshot()
				all[0].Segs[0], all[0].Segments[0].Done = -2, -2
			}
		}()
	}
	if err := m.Cancel(id, true); err != nil {
		t.Error(err)
	}
	close(stopReaders)
	readers.Wait()
	s := waitTask(t, m, id)
	if s.Status != StatusCanceled || s.Speed != 0 || s.EtaSec != -1 || s.Segments[0].Done < 0 || s.Segs[0] < 0 {
		t.Errorf("cancel or snapshot aliasing: %+v", s)
	}
	eventually(t, "all canceled segment handlers stop", func() bool { return active.Load() == 0 })
	assertFiles(t, dir, nil)
}

func TestSegmentHTTPErrorCancelsBlockedSiblings(t *testing.T) {
	payload := testPayload(2 * 1024 * 1024)
	started := make(chan struct{})
	var active atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rangeHeaders(w, len(payload))
		if r.Method == http.MethodHead {
			return
		}
		start, end := testRange(t, r, len(payload))
		if end == 0 {
			writeTestRange(w, payload, start, end)
			return
		}
		active.Add(1)
		defer active.Add(-1)
		if start == 0 {
			close(started)
			<-r.Context().Done()
			return
		}
		select {
		case <-started:
			w.Header().Del("Content-Length")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w, "error")
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(server.Close)
	m := testManager(t, Config{SegmentsPerFile: 2})
	dir := t.TempDir()
	s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/error.bin", dir))
	if s.Status != StatusFailed || !strings.Contains(s.Error, "HTTP 503") {
		t.Fatalf("sibling error lost: %+v", s)
	}
	eventually(t, "blocked sibling canceled", func() bool { return active.Load() == 0 })
	assertFiles(t, dir, nil)
}

func TestRangeDependentRedirectCannotMixURIScopedETags(t *testing.T) {
	payload := testPayload(2 * 1024 * 1024)
	for _, redirects := range []bool{false, true} {
		t.Run(fmt.Sprint("range_redirect_", redirects), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/start" {
					http.Redirect(w, r, "/confirmed", http.StatusFound)
					return
				}
				rangeHeaders(w, len(payload))
				if r.Method == http.MethodHead {
					return
				}
				start, end := testRange(t, r, len(payload))
				if redirects && r.URL.Path == "/confirmed" && end > 0 {
					target := "/unrelated-a"
					if start > 0 {
						target = "/unrelated-b"
					}
					http.Redirect(w, r, target, http.StatusFound)
					return
				}
				if r.URL.Path == "/unrelated-b" {
					// A separate URI may legally reuse this ETag for different data.
					other := bytes.Repeat([]byte{99}, len(payload))
					writeTestRange(w, other, start, end)
					return
				}
				writeTestRange(w, payload, start, end)
			}))
			t.Cleanup(server.Close)
			m := testManager(t, Config{SegmentsPerFile: 2})
			dir := t.TempDir()
			s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/start", dir))
			if redirects {
				if s.Status != StatusFailed || !strings.Contains(s.Error, "final URL") {
					t.Fatalf("unrelated resources spliced: %+v", s)
				}
				assertFiles(t, dir, nil)
			} else {
				if s.Status != StatusCompleted || s.SegCount != 2 {
					t.Fatalf("stable initial redirect rejected: %+v", s)
				}
				got, err := os.ReadFile(s.SavePath)
				if err != nil || sha256.Sum256(got) != sha256.Sum256(payload) {
					t.Fatalf("stable redirected SHA256: %v", err)
				}
			}
		})
	}
}
