package main

import (
	"context"
	"time"

	"github.com/tuanhuynh1704/Go-Get-Wails_v2/internal/downloader"
	"github.com/tuanhuynh1704/Go-Get-Wails_v2/internal/dto"
	"github.com/tuanhuynh1704/Go-Get-Wails_v2/internal/util"
)

// The emitter is independent of the Wails runtime so its batching is testable.
type emitter struct {
	emit     func(string, any)
	snapshot func() []downloader.TaskSnapshot
	pending  map[string]dto.ProgressItem
}

func newEmitter(emit func(string, any), snapshot func() []downloader.TaskSnapshot) *emitter {
	return &emitter{emit: emit, snapshot: snapshot, pending: make(map[string]dto.ProgressItem)}
}

func (e *emitter) run(ctx context.Context, events <-chan downloader.Event) {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			e.accept(event)
		case <-ticker.C:
			e.flush()
		}
	}
}

func (e *emitter) accept(event downloader.Event) {
	t := taskDTO(event.Task)
	switch event.Kind {
	case downloader.EvProgress:
		e.pending[t.ID] = dto.ProgressItem{ID: t.ID, Done: t.Done, Total: t.Total, Speed: t.Speed, EtaSec: t.EtaSec, Segs: t.Segs}
	case downloader.EvAdded:
		e.emit("task:added", t)
	case downloader.EvStatus:
		delete(e.pending, t.ID)
		e.emit("task:status", t)
	}
}

func (e *emitter) flush() {
	if len(e.pending) > 0 {
		items := make([]dto.ProgressItem, 0, len(e.pending))
		for id, item := range e.pending {
			items = append(items, item)
			delete(e.pending, id)
		}
		e.emit("tasks:progress", dto.ProgressBatch{Items: items})
	}
	e.emit("stats:update", statsFor(e.snapshot()))
}

func taskDTO(t downloader.TaskSnapshot) dto.TaskDTO {
	return dto.TaskDTO{
		ID: string(t.ID), URL: t.URL, FileName: t.FileName, SaveDir: t.SaveDir,
		Category: util.FileCategory(t.FileName),
		Status:   string(t.Status), Error: t.Error, Total: t.Total, Done: t.Done,
		Speed: t.Speed, EtaSec: t.EtaSec, SegCount: t.SegCount, Resumable: t.Resumable,
		Segs: append([]int{}, t.Segs...), CreatedAt: t.CreatedAt.UnixMilli(),
	}
}

func statsFor(tasks []downloader.TaskSnapshot) dto.Stats {
	var stats dto.Stats
	for _, t := range tasks {
		switch string(t.Status) {
		case "queued":
			stats.Queued++
		case "probing", "downloading":
			stats.Active++
			stats.GlobalSpeed += t.Speed
		}
	}
	return stats
}
