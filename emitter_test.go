package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/tuanhuynh1704/Go-Get-Wails_v2/internal/downloader"
	"github.com/tuanhuynh1704/Go-Get-Wails_v2/internal/dto"
)

func TestEmitterCoalescesAndDeliversTerminalStatusImmediately(t *testing.T) {
	type emitted struct {
		name string
		data any
	}
	var events []emitted
	e := newEmitter(func(name string, data any) { events = append(events, emitted{name, data}) }, func() []downloader.TaskSnapshot { return nil })
	task := downloader.TaskSnapshot{ID: "one", Status: "downloading", Total: 100}
	for _, done := range []int64{10, 20, 30} {
		task.Done = done
		e.accept(downloader.Event{Kind: downloader.EvProgress, Task: task})
	}
	if len(events) != 0 {
		t.Fatal("progress was emitted before batch flush")
	}
	e.flush()
	batch := events[0].data.(dto.ProgressBatch)
	if events[0].name != "tasks:progress" || len(batch.Items) != 1 || batch.Items[0].Done != 30 {
		t.Fatalf("coalescing lost latest absolute progress: %+v", events)
	}
	task.Done = 40
	e.accept(downloader.Event{Kind: downloader.EvProgress, Task: task})
	task.Done, task.Status = 100, "completed"
	e.accept(downloader.Event{Kind: downloader.EvStatus, Task: task})
	if events[len(events)-1].name != "task:status" {
		t.Fatal("terminal state not emitted immediately")
	}
	before := len(events)
	e.flush()
	for _, event := range events[before:] {
		if event.name == "tasks:progress" {
			t.Fatal("stale progress emitted after terminal status")
		}
	}
}

func TestEmitterRunStopsWithoutEvents(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	e := newEmitter(func(string, any) {}, func() []downloader.TaskSnapshot { return nil })
	done := make(chan struct{})
	go func() {
		defer close(done)
		e.run(ctx, make(chan downloader.Event))
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("emitter did not stop after context cancellation")
	}
}

func TestProgressSegmentsEncodeAsArray(t *testing.T) {
	encoded, err := json.Marshal(dto.ProgressItem{Segs: []int{10, 100}})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if values, ok := decoded["segs"].([]any); !ok || len(values) != 2 || values[0] != float64(10) {
		t.Fatalf("frontend requires numeric segment array, got %s", encoded)
	}
}

func TestStatsCountsQueuedAndActive(t *testing.T) {
	tasks := []downloader.TaskSnapshot{{Status: "queued"}, {Status: "probing"}, {Status: "downloading"}, {Status: "completed"}, {Status: "canceled"}, {Status: "failed"}}
	if stats := statsFor(tasks); stats.Active != 2 || stats.Queued != 1 {
		t.Fatalf("incorrect stats: %+v", stats)
	}
}

func TestEmitterDoesNotRepeatProgressWithoutChanges(t *testing.T) {
	var batches []dto.ProgressBatch
	e := newEmitter(func(name string, value any) {
		if name == "tasks:progress" {
			batches = append(batches, value.(dto.ProgressBatch))
		}
	}, func() []downloader.TaskSnapshot { return nil })
	e.flush()
	if len(batches) != 0 {
		t.Fatal("empty emitter produced a progress event")
	}
	for _, id := range []downloader.TaskID{"one", "two"} {
		e.accept(downloader.Event{Kind: downloader.EvProgress, Task: downloader.TaskSnapshot{ID: id, Done: 42}})
	}
	e.flush()
	e.flush()
	if len(batches) != 1 || len(batches[0].Items) != 2 {
		t.Fatalf("progress should batch both tasks exactly once: %+v", batches)
	}
	for _, item := range batches[0].Items {
		if item.Done != 42 || item.Segs == nil {
			t.Fatalf("invalid progress item: %+v", item)
		}
	}
}

func TestEmitterStopsOnClosedManagerEvents(t *testing.T) {
	events := make(chan downloader.Event)
	close(events)
	done := make(chan struct{})
	e := newEmitter(func(string, any) {}, func() []downloader.TaskSnapshot { return nil })
	go func() {
		defer close(done)
		e.run(context.Background(), events)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("emitter did not stop after manager closed its channel")
	}
}
