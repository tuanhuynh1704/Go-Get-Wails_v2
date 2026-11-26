package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tuanhuynh1704/Go-Get-Wails_v2/internal/downloader"
	"github.com/tuanhuynh1704/Go-Get-Wails_v2/internal/dto"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	mu          sync.RWMutex
	ctx         context.Context
	mgr         *downloader.Manager
	settings    dto.Settings
	approved    map[string]bool
	startupErr  error
	stopEmitter context.CancelFunc
	emitterDone chan struct{}
}

func NewApp() *App { return &App{approved: make(map[string]bool)} }

func (a *App) startup(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ctx = ctx
	home, err := os.UserHomeDir()
	if err != nil {
		a.startupErr = fmt.Errorf("E_CONFIG: %w", err)
		return
	}
	dir := filepath.Join(home, "Downloads", "GoGet")
	if err = os.MkdirAll(dir, 0o755); err != nil {
		a.startupErr = fmt.Errorf("E_DIRECTORY: %w", err)
		return
	}
	dir, err = canonicalDirectory(dir)
	if err != nil {
		a.startupErr = err
		return
	}
	a.settings = dto.Settings{DownloadDir: dir, MaxConcurrentFiles: 3, SegmentsPerFile: 1}
	a.approved[dir] = true
	a.mgr = downloader.NewManager(downloader.Config{MaxConcurrentFiles: 3})
	emCtx, stop := context.WithCancel(context.Background())
	a.stopEmitter, a.emitterDone = stop, make(chan struct{})
	em := newEmitter(func(name string, data any) { runtime.EventsEmit(ctx, name, data) }, a.mgr.Snapshot)
	go func() {
		defer close(a.emitterDone)
		em.run(emCtx, a.mgr.Events())
	}()
}

func (a *App) manager() (*downloader.Manager, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if a.startupErr != nil {
		return nil, a.startupErr
	}
	if a.mgr == nil {
		return nil, errors.New("E_NOT_READY: download manager is not running")
	}
	return a.mgr, nil
}

func (a *App) GetSettings() (dto.Settings, error) {
	if _, err := a.manager(); err != nil {
		return dto.Settings{}, err
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.settings, nil
}

func (a *App) AddURLs(req dto.AddRequest) (dto.AddResult, error) {
	result := dto.AddResult{IDs: []string{}, Errors: []dto.AddError{}}
	mgr, err := a.manager()
	if err != nil {
		return result, err
	}
	if len(req.URLs) == 0 || len(req.URLs) > 100 {
		return result, errors.New("E_INPUT: provide between 1 and 100 URLs")
	}
	a.mu.RLock()
	dir := req.SaveDir
	if dir == "" {
		dir = a.settings.DownloadDir
	}
	approved := a.approved[dir]
	a.mu.RUnlock()
	if !approved {
		return result, errors.New("E_DIRECTORY: select the download directory using the directory picker")
	}
	for _, raw := range req.URLs {
		u := strings.TrimSpace(raw)
		id, err := mgr.Add(context.Background(), downloader.AddRequest{URL: u, SaveDir: dir})
		if err != nil {
			result.Errors = append(result.Errors, dto.AddError{URL: u, Error: err.Error()})
			continue
		}
		result.IDs = append(result.IDs, string(id))
	}
	return result, nil
}

func (a *App) ListTasks() (dto.Snapshot, error) {
	mgr, err := a.manager()
	if err != nil {
		return dto.Snapshot{}, err
	}
	tasks := mgr.Snapshot()
	result := dto.Snapshot{Tasks: make([]dto.TaskDTO, 0, len(tasks)), Stats: statsFor(tasks)}
	for _, t := range tasks {
		result.Tasks = append(result.Tasks, taskDTO(t))
	}
	return result, nil
}

func (a *App) Cancel(id string, deleteFile bool) error {
	mgr, err := a.manager()
	if err != nil {
		return err
	}
	return mgr.Cancel(downloader.TaskID(id), deleteFile)
}

func (a *App) CancelAll() error {
	mgr, err := a.manager()
	if err != nil {
		return err
	}
	return mgr.CancelAll()
}

func (a *App) PickDirectory() (string, error) {
	if _, err := a.manager(); err != nil {
		return "", err
	}
	a.mu.RLock()
	ctx, dir := a.ctx, a.settings.DownloadDir
	a.mu.RUnlock()
	picked, err := runtime.OpenDirectoryDialog(ctx, runtime.OpenDialogOptions{
		Title: "Chon thu muc tai xuong", DefaultDirectory: dir,
	})
	if err != nil || picked == "" {
		return picked, err
	}
	picked, err = canonicalDirectory(picked)
	if err != nil {
		return "", err
	}
	a.mu.Lock()
	a.approved[picked] = true
	a.mu.Unlock()
	return picked, nil
}

func canonicalDirectory(path string) (string, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("E_DIRECTORY: %w", err)
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("E_DIRECTORY: %w", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("E_DIRECTORY: %w", err)
	}
	if !info.IsDir() {
		return "", errors.New("E_DIRECTORY: expected a directory")
	}
	return path, nil
}

func (a *App) beforeClose(ctx context.Context) bool {
	mgr, err := a.manager()
	if err != nil {
		return false
	}
	stats := statsFor(mgr.Snapshot())
	if stats.Active+stats.Queued == 0 {
		return false
	}
	answer, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type: runtime.QuestionDialog, Title: "GoGet",
		Message: "Downloads are still active. Exit and cancel them? v0.1 cannot resume downloads after closing.",
		Buttons: []string{"Yes", "No"}, DefaultButton: "No", CancelButton: "No",
	})
	return err != nil || answer != "Yes"
}

func (a *App) shutdown(context.Context) {
	mgr, err := a.manager()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := mgr.Shutdown(ctx); err != nil {
		slog.Warn("download manager shutdown exceeded deadline", "error", err)
	}
	a.stopEmitter()
	select {
	case <-a.emitterDone:
	case <-ctx.Done():
		slog.Warn("event emitter shutdown exceeded deadline")
	}
}
