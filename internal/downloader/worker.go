package downloader

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tuanhuynh1704/Go-Get-Wails_v2/internal/util"
)

var errIdleTimeout = errors.New("download idle timeout")

func (m *Manager) worker() {
	defer m.wg.Done()
	for {
		m.mu.Lock()
		for len(m.queue) == 0 && !m.closed {
			m.ready.Wait()
		}
		if m.closed {
			m.mu.Unlock()
			return
		}
		t := m.queue[0]
		m.queue[0] = nil
		m.queue = m.queue[1:]
		if t.ctx.Err() != nil {
			m.finishLocked(t, StatusCanceled, nil)
			m.mu.Unlock()
			continue
		}
		t.started = true
		t.snapshot.Status = StatusProbing
		m.emitLocked(EvStatus, t)
		m.mu.Unlock()
		m.download(t)
	}
}

func (m *Manager) download(t *runtimeTask) {
	files, err := m.transfer(t)
	if err == nil {
		// Serialize publication and cancellation so a published file is always
		// completed, and Cancel can never remove it afterward.
		m.mu.Lock()
		if t.ctx.Err() == nil {
			err = files.publish()
			if err == nil {
				m.finishLocked(t, StatusCompleted, nil)
				m.mu.Unlock()
				return
			}
		}
		m.mu.Unlock()
	}
	if files != nil {
		err = errors.Join(err, files.cleanup())
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if t.ctx.Err() != nil {
		// Cleanup errors are retained for diagnostics even when the user canceled.
		m.finishLocked(t, StatusCanceled, err)
	} else {
		m.finishLocked(t, StatusFailed, err)
	}
}

func (m *Manager) transfer(t *runtimeTask) (*ownedFiles, error) {
	requestCtx, cancel := context.WithCancelCause(t.ctx)
	defer cancel(nil)
	// Reset on received bytes, rather than imposing a deadline on the file.
	idle := time.AfterFunc(m.idleTimeout, func() { cancel(errIdleTimeout) })
	defer idle.Stop()
	requestCtx = context.WithValue(requestCtx, activityKey{}, func() { idle.Reset(m.idleTimeout) })
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, t.snapshot.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "GoGet/0.1")
	req.Header.Set("Accept-Encoding", "identity")
	resp, err := m.client.Do(req)
	if err != nil {
		if errors.Is(context.Cause(requestCtx), errIdleTimeout) {
			return nil, errIdleTimeout
		}
		return nil, fmt.Errorf("GET request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	}
	if encoding := resp.Header.Get("Content-Encoding"); encoding != "" && !strings.EqualFold(encoding, "identity") {
		return nil, fmt.Errorf("unsupported Content-Encoding: %s", encoding)
	}
	idle.Reset(m.idleTimeout)
	finalURL := t.snapshot.URL
	if resp.Request != nil && resp.Request.URL != nil {
		finalURL = resp.Request.URL.String()
	}
	name := util.FileName(resp.Header.Get("Content-Disposition"), finalURL)
	files, err := reserveFiles(t.snapshot.SaveDir, name)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	t.snapshot.FileName = filepath.Base(files.target)
	t.snapshot.SavePath = files.target
	t.snapshot.Total = resp.ContentLength
	t.snapshot.Status = StatusDownloading
	m.emitLocked(EvStatus, t)
	m.mu.Unlock()
	buf := make([]byte, 64*1024)
	for {
		if err := requestCtx.Err(); err != nil {
			if errors.Is(context.Cause(requestCtx), errIdleTimeout) {
				err = errIdleTimeout
			}
			return files, err
		}
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			idle.Reset(m.idleTimeout)
			written, writeErr := files.file.Write(buf[:n])
			m.mu.Lock()
			t.snapshot.Done += int64(written)
			m.mu.Unlock()
			if writeErr != nil {
				return files, fmt.Errorf("write download: %w", writeErr)
			}
			if written != n {
				return files, io.ErrShortWrite
			}
		}
		if readErr != nil {
			if errors.Is(context.Cause(requestCtx), errIdleTimeout) {
				return files, errIdleTimeout
			}
			if readErr != io.EOF {
				return files, fmt.Errorf("read download: %w", readErr)
			}
			break
		}
	}
	m.mu.Lock()
	done, total := t.snapshot.Done, t.snapshot.Total
	m.mu.Unlock()
	if total >= 0 && done != total {
		return files, fmt.Errorf("incomplete response: wrote %d of %d bytes: %w", done, total, io.ErrUnexpectedEOF)
	}
	if err := files.file.Sync(); err != nil {
		return files, fmt.Errorf("sync download: %w", err)
	}
	if err := files.file.Close(); err != nil {
		files.file = nil
		return files, fmt.Errorf("close download: %w", err)
	}
	files.file = nil
	return files, nil
}

type ownedFiles struct {
	target   string
	temp     string
	tempInfo os.FileInfo
	file     *os.File
}

func reserveFiles(dir, name string) (*ownedFiles, error) {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 0; ; i++ {
		candidate := name
		if i > 0 {
			candidate = fmt.Sprintf("%s (%d)%s", stem, i, ext)
		}
		target := filepath.Join(dir, candidate)
		if rel, err := filepath.Rel(dir, target); err != nil || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("filename escapes save directory")
		}
		if _, err := os.Lstat(target); err == nil {
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("reserve target: %w", err)
		}
		f := &ownedFiles{target: target, temp: target + ".goget"}
		var err error
		f.file, err = os.OpenFile(f.temp, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			if errors.Is(err, os.ErrExist) {
				continue
			}
			// Windows may report access denied for a temporary name still being
			// removed by a concurrent move. Its published destination proves the
			// collision; unrelated directory permission errors still fail promptly.
			if _, targetErr := os.Lstat(target); targetErr == nil {
				continue
			}
			if _, tempErr := os.Lstat(f.temp); tempErr == nil {
				continue
			}
			return nil, fmt.Errorf("reserve temporary file: %w", err)
		}
		f.tempInfo, err = f.file.Stat()
		if err != nil {
			return nil, errors.Join(err, f.cleanup())
		}
		// A prior transfer may have published after the first check, freeing its
		// temporary name just before our exclusive create succeeded.
		if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
			cleanupErr := f.cleanup()
			if err == nil && cleanupErr == nil {
				continue
			}
			return nil, errors.Join(fmt.Errorf("recheck target: %v", err), cleanupErr)
		}
		return f, nil
	}
}

func sameOwned(path string, info os.FileInfo) error {
	current, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info == nil || !os.SameFile(current, info) {
		return fmt.Errorf("file ownership changed: %s", filepath.Base(path))
	}
	return nil
}

func removeOwned(path string, info os.FileInfo) error {
	if info == nil {
		return nil
	}
	if err := sameOwned(path, info); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	return os.Remove(path)
}

func (f *ownedFiles) cleanup() error {
	var closeErr error
	if f.file != nil {
		closeErr = f.file.Close()
		f.file = nil
	}
	return errors.Join(closeErr, removeOwned(f.temp, f.tempInfo))
}

func (f *ownedFiles) publish() error {
	if err := sameOwned(f.temp, f.tempInfo); err != nil {
		return fmt.Errorf("publish temporary file: %w", err)
	}
	if err := publishFile(f.temp, f.target); err != nil {
		return fmt.Errorf("publish download: %w", err)
	}
	return nil
}
