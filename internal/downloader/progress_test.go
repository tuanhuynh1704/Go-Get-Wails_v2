package downloader

import (
	"context"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestSmoothedSpeedETADecayAndOverflow(t *testing.T) {
	now := time.Unix(1000, 0)
	task := &runtimeTask{lastSample: now, snapshot: TaskSnapshot{Done: 200000, Total: 1000000}}
	sampleProgress(task, now.Add(200*time.Millisecond))
	if task.snapshot.Speed != 300000 || task.snapshot.EtaSec != 3 {
		t.Fatalf("first sample: %+v", task.snapshot)
	}
	sampleProgress(task, now.Add(400*time.Millisecond))
	if task.snapshot.Speed != 210000 || task.snapshot.EtaSec != 4 {
		t.Fatalf("idle estimates did not decay: %+v", task.snapshot)
	}
	task.snapshot.Total = -1
	sampleProgress(task, now.Add(600*time.Millisecond))
	if task.snapshot.EtaSec != -1 {
		t.Error("unknown length has an ETA")
	}
	task.snapshot.Total, task.snapshot.Done = math.MaxInt64, math.MaxInt64-1
	sampleProgress(task, now.Add(600*time.Millisecond+time.Nanosecond))
	if task.snapshot.Speed != math.MaxInt64 || task.snapshot.EtaSec < 0 {
		t.Errorf("overflowed speed or ETA: %+v", task.snapshot)
	}
	task.snapshot.Segments = []SegmentSnapshot{{Start: 0, End: math.MaxInt64 - 1, Done: math.MaxInt64 - 1, Status: "downloading"}}
	refreshSegments(&task.snapshot)
	if task.snapshot.Segs[0] != 99 {
		t.Errorf("incomplete huge segment rounded to %d%%", task.snapshot.Segs[0])
	}
}

func TestProgressTickerDecaysSpeedWithoutBytesOrEventConsumer(t *testing.T) {
	gate := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(gate) }) }
	defer release()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "6")
		if r.Method == http.MethodHead {
			return
		}
		_, _ = io.WriteString(w, "abc")
		w.(http.Flusher).Flush()
		select {
		case <-gate:
			_, _ = io.WriteString(w, "def")
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(server.Close)
	m := testManager(t, Config{})
	id := addTask(t, m, context.Background(), server.URL+"/speed.bin", t.TempDir())
	var initial int64
	eventually(t, "first actual speed sample", func() bool { s, _ := m.Get(id); initial = s.Speed; return s.Done == 3 && s.Speed > 1 })
	eventually(t, "idle speed decay at unchanged byte count", func() bool { s, _ := m.Get(id); return s.Done == 3 && s.Speed < initial })
	release()
	if s := waitTask(t, m, id); s.Status != StatusCompleted || s.Speed != 0 || s.EtaSec != 0 {
		t.Errorf("terminal estimates: %+v", s)
	}
}

func TestSnapshotGetAndEventSlicesAreIndependent(t *testing.T) {
	m := testManager(t, Config{})
	value := TaskSnapshot{ID: "isolated", SegCount: 1, Segs: []int{25}, Segments: []SegmentSnapshot{{Index: 0, Start: 0, End: 99, Done: 25, Status: "downloading"}}}
	task := &runtimeTask{snapshot: value}
	m.mu.Lock()
	m.tasks[value.ID], m.order = task, []*runtimeTask{task}
	m.emitLocked(EvStatus, task)
	m.emitLocked(EvProgress, task)
	m.mu.Unlock()
	first := <-m.Events()
	second := <-m.Events()
	first.Task.Segs[0], first.Task.Segments[0].Done = 90, 90
	if second.Task.Segs[0] != 25 || second.Task.Segments[0].Done != 25 {
		t.Error("events share slices")
	}
	get, _ := m.Get(value.ID)
	get.Segs[0], get.Segments[0].Done = 80, 80
	all := m.Snapshot()
	all[0].Segs[0], all[0].Segments[0].Done = 70, 70
	current, _ := m.Get(value.ID)
	if current.Segs[0] != 25 || current.Segments[0].Done != 25 || second.Task.Segs[0] != 25 || second.Task.Segments[0].Done != 25 {
		t.Error("snapshot, Get, or event exposes mutable slices")
	}
	// This manually installed terminal task has no worker or lifecycle handles.
	m.mu.Lock()
	task.snapshot.Status = StatusCompleted
	m.mu.Unlock()
}
