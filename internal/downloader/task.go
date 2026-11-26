// Package downloader implements the independent, single-stream v0.1 download core.
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
	CreatedAt time.Time
}

type Config struct {
	MaxConcurrentFiles int
	Client             *http.Client
}

type AddRequest struct {
	URL     string
	SaveDir string
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
