package downloader

import (
	"context"
	"crypto/rand"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tuanhuynh1704/Go-Get-Wails_v2/internal/util"
)

const queueCapacity = 1024

type runtimeTask struct {
	snapshot          TaskSnapshot
	ctx               context.Context
	cancel            context.CancelFunc
	stop              func() bool
	finished          chan struct{}
	started           bool
	lastDone          int64
	lastSample        time.Time
	speed             float64
	requestedSegments int
}

type Manager struct {
	mu              sync.Mutex
	ready           *sync.Cond
	tasks           map[TaskID]*runtimeTask
	order           []*runtimeTask
	queue           []*runtimeTask
	closed          bool
	root            context.Context
	cancel          context.CancelFunc
	client          *http.Client
	ownedClient     bool
	idleTimeout     time.Duration
	segmentsPerFile int
	wg              sync.WaitGroup
	done            chan struct{}
	events          chan Event
	eventQueue      []Event
	eventWake       chan struct{}
	relayStop       chan struct{}
	relayDone       chan struct{}
}

func NewManager(cfg Config) *Manager {
	if cfg.MaxConcurrentFiles <= 0 {
		cfg.MaxConcurrentFiles = 3
	}
	if cfg.MaxConcurrentFiles > 10 {
		cfg.MaxConcurrentFiles = 10
	}
	if cfg.SegmentsPerFile <= 0 {
		cfg.SegmentsPerFile = 8
	}
	if cfg.SegmentsPerFile > 32 {
		cfg.SegmentsPerFile = 32
	}
	owned := cfg.Client == nil
	if owned {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.DisableCompression = true
		transport.DialContext = (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext
		transport.TLSHandshakeTimeout = 15 * time.Second
		transport.ResponseHeaderTimeout = 30 * time.Second
		transport.IdleConnTimeout = 90 * time.Second
		transport.MaxIdleConns = 100
		transport.MaxIdleConnsPerHost = cfg.MaxConcurrentFiles * 32
		cfg.Client = &http.Client{Transport: transport}
	}
	client := *cfg.Client
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	client.Transport = activityTransport{base: transport}
	checkRedirect := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
			return fmt.Errorf("redirect requires http or https")
		}
		if len(via) > 0 && via[len(via)-1].URL.Scheme == "https" && req.URL.Scheme != "https" {
			return fmt.Errorf("HTTPS redirect cannot downgrade to HTTP")
		}
		if len(via) >= 10 {
			return fmt.Errorf("stopped after 10 redirects")
		}
		if checkRedirect != nil {
			return checkRedirect(req, via)
		}
		return nil
	}
	root, cancel := context.WithCancel(context.Background())
	m := &Manager{
		tasks: make(map[TaskID]*runtimeTask), root: root, cancel: cancel,
		client: &client, ownedClient: owned, idleTimeout: 30 * time.Second,
		segmentsPerFile: cfg.SegmentsPerFile,
		done:            make(chan struct{}), events: make(chan Event), eventWake: make(chan struct{}, 1),
		relayStop: make(chan struct{}), relayDone: make(chan struct{}),
	}
	m.ready = sync.NewCond(&m.mu)
	go m.relay()
	m.wg.Add(cfg.MaxConcurrentFiles + 1)
	for i := 0; i < cfg.MaxConcurrentFiles; i++ {
		go m.worker()
	}
	go m.progress()
	return m
}

func (m *Manager) Add(ctx context.Context, req AddRequest) (TaskID, error) {
	if ctx == nil {
		return "", fmt.Errorf("task context is required")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if req.Segments < 0 || req.Segments > 32 {
		return "", fmt.Errorf("segments must be between 1 and 32, or zero for the default")
	}
	if req.Segments == 0 {
		req.Segments = m.segmentsPerFile
	}
	u, err := url.Parse(req.URL)
	if err != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.Opaque != "" || strings.ContainsAny(req.URL, "\r\n") {
		return "", fmt.Errorf("URL must be an absolute http or https URL")
	}
	if _, err := http.NewRequest(http.MethodGet, req.URL, nil); err != nil {
		return "", fmt.Errorf("invalid URL: %w", err)
	}
	if !filepath.IsAbs(req.SaveDir) {
		return "", fmt.Errorf("save directory must be absolute")
	}
	dir := filepath.Clean(req.SaveDir)
	info, err := os.Stat(dir)
	if err != nil {
		return "", fmt.Errorf("save directory: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("save path is not a directory")
	}
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", fmt.Errorf("generate task ID: %w", err)
	}
	bytes[6] = bytes[6]&0x0f | 0x40
	bytes[8] = bytes[8]&0x3f | 0x80
	id := TaskID(fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:]))
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return "", ErrClosed
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if len(m.queue) >= queueCapacity {
		return "", ErrQueueFull
	}
	taskCtx, cancel := context.WithCancel(ctx)
	t := &runtimeTask{
		snapshot: TaskSnapshot{ID: id, URL: req.URL, SaveDir: dir, FileName: util.FileName("", req.URL), Status: StatusQueued, Total: -1, EtaSec: -1, CreatedAt: time.Now()},
		ctx:      taskCtx, cancel: cancel, finished: make(chan struct{}),
		requestedSegments: req.Segments,
	}
	m.tasks[id] = t
	m.order = append(m.order, t)
	m.queue = append(m.queue, t)
	m.emitLocked(EvAdded, t)
	t.stop = context.AfterFunc(ctx, func() { _ = m.Cancel(id, true) })
	m.ready.Signal()
	return id, nil
}

func (m *Manager) Snapshot() []TaskSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := make([]TaskSnapshot, 0, len(m.order))
	for _, t := range m.order {
		result = append(result, cloneSnapshot(t.snapshot))
	}
	return result
}

func (m *Manager) Get(id TaskID) (TaskSnapshot, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.tasks[id]
	if !ok {
		return TaskSnapshot{}, false
	}
	return cloneSnapshot(t.snapshot), true
}

// Cancel waits for cleanup. deleteFile is retained for the adapter contract;
// incomplete files are always removed, and completed files are never removed.
func (m *Manager) Cancel(id TaskID, deleteFile bool) error {
	m.mu.Lock()
	t, ok := m.tasks[id]
	if !ok {
		m.mu.Unlock()
		return ErrNotFound
	}
	if t.snapshot.Status == StatusCompleted {
		m.mu.Unlock()
		return ErrCompleted
	}
	m.cancelLocked(t)
	m.mu.Unlock()
	<-t.finished
	return nil
}

func (m *Manager) cancelLocked(t *runtimeTask) {
	if terminal(t.snapshot.Status) {
		return
	}
	t.cancel()
	if !t.started {
		for i, pending := range m.queue {
			if pending == t {
				m.queue = append(m.queue[:i], m.queue[i+1:]...)
				break
			}
		}
		m.finishLocked(t, StatusCanceled, nil)
	}
}

// CancelAll cancels the set of unfinished tasks present at the call's lock point.
func (m *Manager) CancelAll() error {
	m.mu.Lock()
	var wait []chan struct{}
	for _, t := range m.order {
		if !terminal(t.snapshot.Status) {
			m.cancelLocked(t)
			wait = append(wait, t.finished)
		}
	}
	m.mu.Unlock()
	for _, done := range wait {
		<-done
	}
	return nil
}

// Events delivers status changes in order without blocking task work. Progress
// may be coalesced. Shutdown closes this channel and discards any undelivered
// backlog so an absent consumer cannot prevent shutdown. Get/Snapshot retain
// the final state after shutdown.
func (m *Manager) Events() <-chan Event { return m.events }

func (m *Manager) Shutdown(ctx context.Context) error {
	m.mu.Lock()
	if !m.closed {
		m.closed = true
		m.cancel()
		for _, t := range m.order {
			m.cancelLocked(t)
		}
		m.ready.Broadcast()
		go func() {
			m.wg.Wait()
			if m.ownedClient {
				m.client.CloseIdleConnections()
			}
			close(m.relayStop)
			<-m.relayDone
			close(m.done)
		}()
	}
	m.mu.Unlock()
	select {
	case <-m.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *Manager) finishLocked(t *runtimeTask, status Status, err error) {
	t.snapshot.Status = status
	t.snapshot.Speed = 0
	t.snapshot.EtaSec = -1
	if status == StatusCompleted {
		t.snapshot.EtaSec = 0
	}
	for i := range t.snapshot.Segments {
		if t.snapshot.Segments[i].Status == string(StatusQueued) || t.snapshot.Segments[i].Status == string(StatusDownloading) {
			t.snapshot.Segments[i].Status = string(status)
		}
	}
	refreshSegments(&t.snapshot)
	if err != nil {
		t.snapshot.Error = err.Error()
	}
	if t.stop != nil {
		t.stop()
	}
	t.cancel()
	m.emitLocked(EvStatus, t)
	close(t.finished)
}

func (m *Manager) emitLocked(kind EventKind, t *runtimeTask) {
	m.eventQueue = append(m.eventQueue, Event{Kind: kind, Task: cloneSnapshot(t.snapshot)})
	select {
	case m.eventWake <- struct{}{}:
	default:
	}
}

func (m *Manager) relay() {
	defer close(m.relayDone)
	defer close(m.events)
	for {
		m.mu.Lock()
		var out chan Event
		var next Event
		if len(m.eventQueue) > 0 {
			out, next = m.events, m.eventQueue[0]
		}
		m.mu.Unlock()
		select {
		case <-m.relayStop:
			m.mu.Lock()
			m.eventQueue = nil
			m.mu.Unlock()
			return
		case <-m.eventWake:
		case out <- next:
			m.mu.Lock()
			m.eventQueue[0] = Event{}
			m.eventQueue = m.eventQueue[1:]
			m.mu.Unlock()
		}
	}
}

func (m *Manager) progress() {
	defer m.wg.Done()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-m.root.Done():
			return
		case now := <-ticker.C:
			m.mu.Lock()
			// Sample even with an absent consumer or unchanged byte count: idle
			// estimates must decay. Never build progress behind a status backlog.
			canEmit := len(m.eventQueue) == 0
			for _, t := range m.order {
				if t.snapshot.Status == StatusDownloading {
					sampleProgress(t, now)
					if canEmit {
						m.emitLocked(EvProgress, t)
					}
				}
			}
			m.mu.Unlock()
		}
	}
}
