package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tuanhuynh1704/Go-Get-Wails_v2/internal/downloader"
	"github.com/tuanhuynh1704/Go-Get-Wails_v2/internal/dto"
	"go.uber.org/goleak"
)

func TestMain(m *testing.M) { goleak.VerifyTestMain(m) }

func testApp(t *testing.T) *App {
	t.Helper()
	dir := t.TempDir()
	a := NewApp()
	a.mgr = downloader.NewManager(downloader.Config{MaxConcurrentFiles: 1, SegmentsPerFile: 1})
	a.settings = dto.Settings{DownloadDir: dir, MaxConcurrentFiles: 1, SegmentsPerFile: 1}
	a.approved[dir] = true
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := a.mgr.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	return a
}

func TestAppRejectsUnapprovedDirectory(t *testing.T) {
	a := testApp(t)
	_, err := a.AddURLs(dto.AddRequest{URLs: []string{"https://example.com/file"}, SaveDir: t.TempDir()})
	if err == nil {
		t.Fatal("arbitrary frontend directory accepted")
	}
	if len(a.mgr.Snapshot()) != 0 {
		t.Fatal("rejected request created tasks")
	}
}

func TestAppBatchValidationAndPartialResults(t *testing.T) {
	a := testApp(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("GoGet adapter test"))
	}))
	defer server.Close()
	for _, urls := range [][]string{nil, make([]string, 101)} {
		if _, err := a.AddURLs(dto.AddRequest{URLs: urls}); err == nil {
			t.Fatalf("invalid batch size accepted: %d", len(urls))
		}
	}
	result, err := a.AddURLs(dto.AddRequest{URLs: []string{server.URL + "/file.txt", "file:///private/file"}})
	if err != nil || len(result.IDs) != 1 || len(result.Errors) != 1 {
		t.Fatalf("unexpected partial result: %+v, %v", result, err)
	}
	snapshot, err := a.ListTasks()
	if err != nil || len(snapshot.Tasks) != 1 || snapshot.Tasks[0].ID != result.IDs[0] {
		t.Fatalf("snapshot does not include accepted task: %+v, %v", snapshot, err)
	}
	if snapshot.Tasks[0].SaveDir != a.settings.DownloadDir {
		t.Fatal("default download directory not applied")
	}
}

func TestAppNotReadyReturnsErrors(t *testing.T) {
	a := NewApp()
	if _, err := a.ListTasks(); err == nil {
		t.Fatal("ListTasks succeeded without startup")
	}
	if _, err := a.GetTaskDetail("unknown"); err == nil {
		t.Fatal("GetTaskDetail succeeded without startup")
	}
	if _, err := a.GetSettings(); err == nil {
		t.Fatal("GetSettings succeeded without startup")
	}
	if err := a.CancelAll(); err == nil {
		t.Fatal("CancelAll succeeded without startup")
	}
	if _, err := a.AddURLs(dto.AddRequest{URLs: []string{"https://example.com/file"}}); err == nil {
		t.Fatal("AddURLs succeeded without startup")
	}
	if err := a.Cancel("unknown", true); err == nil {
		t.Fatal("Cancel succeeded without startup")
	}
	if _, err := a.PickDirectory(); err == nil {
		t.Fatal("PickDirectory succeeded without startup")
	}
}

func TestAppRejectsInvalidSegmentCountsBeforeAddingTasks(t *testing.T) {
	a := testApp(t)
	for _, segments := range []int{-1, 33} {
		if _, err := a.AddURLs(dto.AddRequest{URLs: []string{"https://example.com/file"}, Segments: segments}); err == nil || !strings.Contains(err.Error(), "E_INPUT") {
			t.Fatalf("segments %d: expected E_INPUT, got %v", segments, err)
		}
	}
	if len(a.mgr.Snapshot()) != 0 {
		t.Fatal("invalid segment count created tasks")
	}
	if _, err := a.GetTaskDetail("unknown"); !errors.Is(err, downloader.ErrNotFound) {
		t.Fatalf("unknown detail = %v", err)
	}
}

func TestAppSegmentedDownloadDetail(t *testing.T) {
	a := testApp(t)
	payload := bytes.Repeat([]byte("GoGet segmented bridge\n"), 180000)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("ETag", `"bridge-v2"`)
		http.ServeContent(w, r, "segments.bin", time.Time{}, bytes.NewReader(payload))
	}))
	defer server.Close()
	result, err := a.AddURLs(dto.AddRequest{URLs: []string{server.URL + "/segments.bin"}, Segments: 3})
	if err != nil || len(result.IDs) != 1 || len(result.Errors) != 0 {
		t.Fatalf("add segmented task: %+v, %v", result, err)
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		select {
		case event := <-a.mgr.Events():
			if event.Task.Status == downloader.StatusFailed {
				t.Fatalf("segmented bridge failed: %s", event.Task.Error)
			}
			if event.Task.Status != downloader.StatusCompleted {
				continue
			}
			detail, err := a.GetTaskDetail(result.IDs[0])
			if err != nil || detail.Task.SegCount != 3 || len(detail.Segments) != 3 || len(detail.Task.Segs) != 3 {
				t.Fatalf("unexpected detail: %+v, %v", detail, err)
			}
			var cursor, done int64
			for i, segment := range detail.Segments {
				if segment.Index != i || segment.Start != cursor || segment.Done != segment.End-segment.Start+1 || detail.Task.Segs[i] != 100 {
					t.Fatalf("invalid completed segment: %+v", detail)
				}
				cursor = segment.End + 1
				done += segment.Done
			}
			if cursor != int64(len(payload)) || done != detail.Task.Done || detail.Task.Speed != 0 || detail.Task.EtaSec != 0 {
				t.Fatalf("inconsistent completed detail: %+v", detail)
			}
			got, err := os.ReadFile(filepath.Join(a.settings.DownloadDir, detail.Task.FileName))
			if err != nil || sha256.Sum256(got) != sha256.Sum256(payload) {
				t.Fatalf("segmented bridge checksum mismatch: %v", err)
			}
			return
		case <-deadline.C:
			t.Fatal("segmented bridge download did not complete")
		}
	}
}

func TestAppPropagatesStartupFailure(t *testing.T) {
	a := NewApp()
	failure := errors.New("test startup failure")
	a.startupErr = failure
	if _, err := a.GetSettings(); !errors.Is(err, failure) {
		t.Fatalf("startup error was lost: %v", err)
	}
}

func TestCanonicalDirectoryRejectsMissingPathAndFiles(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(file, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{file, filepath.Join(dir, "missing")} {
		if _, err := canonicalDirectory(path); err == nil {
			t.Fatalf("invalid directory accepted: %q", path)
		}
	}
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, err := canonicalDirectory(filepath.Join(dir, "."))
	if err != nil || got != want {
		t.Fatalf("canonical directory = %q, %v; want %q", got, err, want)
	}
}

func TestAppBridgeDownloadsAndEmitsCompletedFile(t *testing.T) {
	a := testApp(t)
	payload := []byte(strings.Repeat("GoGet bridge integrity\n", 8192))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Disposition", `attachment; filename="bridge.PDF"`)
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	emCtx, stop := context.WithCancel(context.Background())
	defer stop()
	type emitted struct {
		name string
		task dto.TaskDTO
	}
	events := make(chan emitted, 16)
	em := newEmitter(func(name string, value any) {
		if task, ok := value.(dto.TaskDTO); ok {
			events <- emitted{name: name, task: task}
		}
	}, a.mgr.Snapshot)
	emDone := make(chan struct{})
	go func() {
		defer close(emDone)
		em.run(emCtx, a.mgr.Events())
	}()
	t.Cleanup(func() { stop(); <-emDone })
	result, err := a.AddURLs(dto.AddRequest{URLs: []string{" \t" + server.URL + "/original.mp3 \n"}})
	if err != nil || len(result.IDs) != 1 || len(result.Errors) != 0 {
		t.Fatalf("add URLs = %+v, %v", result, err)
	}
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	added := false
	for {
		select {
		case event := <-events:
			if event.task.ID != result.IDs[0] {
				t.Fatalf("wrong task ID in event: %+v", event)
			}
			if event.name == "task:added" {
				added = true
				if event.task.Category != "music" {
					t.Fatalf("initial URL filename category = %q, want music", event.task.Category)
				}
			}
			if event.task.Status == "failed" {
				t.Fatalf("bridge download failed: %s", event.task.Error)
			}
			if event.task.Status != "completed" {
				continue
			}
			if !added || event.task.Done != int64(len(payload)) || event.task.FileName != "bridge.PDF" || event.task.Category != "doc" {
				t.Fatalf("unexpected completed event: %+v; added=%v", event, added)
			}
			snapshot, err := a.ListTasks()
			if err != nil || len(snapshot.Tasks) != 1 || snapshot.Tasks[0].Category != "doc" {
				t.Fatalf("snapshot lost corrected file category: %+v, %v", snapshot, err)
			}
			detail, err := a.GetTaskDetail(event.task.ID)
			if err != nil || detail.Task.Category != "doc" || detail.Task.FileName != event.task.FileName {
				t.Fatalf("detail disagrees with completed file: %+v, %v", detail, err)
			}
			got, err := os.ReadFile(filepath.Join(a.settings.DownloadDir, event.task.FileName))
			if err != nil || sha256.Sum256(got) != sha256.Sum256(payload) {
				t.Fatalf("bridge file integrity failed: %v", err)
			}
			if err := a.Cancel(event.task.ID, true); !errors.Is(err, downloader.ErrCompleted) {
				t.Fatalf("completed-file cancellation = %v", err)
			}
			if _, err := os.Stat(filepath.Join(a.settings.DownloadDir, event.task.FileName)); err != nil {
				t.Fatalf("completed file was removed: %v", err)
			}
			return
		case <-deadline.C:
			t.Fatal("completed task event did not reach the frontend bridge")
		}
	}
}
