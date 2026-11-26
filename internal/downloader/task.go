// Package downloader implements the independent, segmented download core.
package downloader

import (
	"errors"
	"net/http"
	"time"
)

type TaskID string
type Status string

const (
	StatusQueued      Status = "queued"
	StatusProbing     Status = "probing"
	StatusDownloading Status = "downloading"
	StatusCompleted   Status = "completed"
	StatusFailed      Status = "failed"
	StatusCanceled    Status = "canceled"
)

type TaskSnapshot struct {
	ID        TaskID
	URL       string
	FileName  string
	SaveDir   string
	SavePath  string
	Status    Status
	Error     string
	Total     int64
	Done      int64
	Speed     int64
	EtaSec    int64
	SegCount  int
	Resumable bool
	Segs      []int
	Segments  []SegmentSnapshot
	CreatedAt time.Time
}

type SegmentSnapshot struct {
	Index  int
	Start  int64
	End    int64 // Inclusive; -1 for an unknown-length stream.
	Done   int64
	Status string
}

type Config struct {
	MaxConcurrentFiles int
	SegmentsPerFile    int
	Client             *http.Client
}

type AddRequest struct {
	URL      string
	SaveDir  string
	Segments int // Zero selects Config.SegmentsPerFile.
}

type EventKind string

const (
	EvAdded    EventKind = "added"
	EvStatus   EventKind = "status"
	EvProgress EventKind = "progress"
)

type Event struct {
	Kind EventKind
	Task TaskSnapshot
}

var (
	ErrQueueFull = errors.New("download queue is full")
	ErrClosed    = errors.New("download manager is shut down")
	ErrNotFound  = errors.New("download task not found")
	ErrCompleted = errors.New("completed download cannot be canceled")
)

func terminal(status Status) bool {
	return status == StatusCompleted || status == StatusFailed || status == StatusCanceled
}

func cloneSnapshot(s TaskSnapshot) TaskSnapshot {
	s.Segs = append([]int(nil), s.Segs...)
	s.Segments = append([]SegmentSnapshot(nil), s.Segments...)
	return s
}
