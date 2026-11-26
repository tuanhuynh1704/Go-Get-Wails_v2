package downloader

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
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
	probe, err := m.probe(t)
	if err != nil {
		return nil, err
	}
	if probe.full != nil {
		defer probe.full.close()
	}
	var response *transferResponse
	parallel := probe.ranges && segmentCount(probe.total, t.requestedSegments) > 1
	if !parallel {
		response = probe.full
		if response == nil {
			response, err = m.request(t.ctx, http.MethodGet, probe.url, "", "")
			if err != nil {
				return nil, err
			}
			defer response.close()
		}
		if err := validateFullResponse(response); err != nil {
			return nil, err
		}
		probe.total = response.ContentLength
		if response.Header.Get("Content-Disposition") != "" || responseURL(response.Response, probe.url) != probe.url {
			probe.name = responseFileName(response.Response, probe.url)
		}
	}
	files, err := reserveFiles(t.snapshot.SaveDir, probe.name)
	if err != nil {
		return nil, err
	}
	if parallel {
		if err := files.file.Truncate(probe.total); err != nil {
			return files, fmt.Errorf("allocate download: %w", err)
		}
		m.startTransfer(t, files, probe.total, split(probe.total, t.requestedSegments), true)
		err = m.downloadSegments(t, files.file, probe)
		if errors.Is(err, errRangeIgnored) && t.ctx.Err() == nil {
			// downloadSegments joins every worker before returning. Only now may
			// we destroy old ranges and restart a fresh, coherent representation.
			if err = files.file.Truncate(0); err != nil {
				return files, fmt.Errorf("reset download: %w", err)
			}
			m.startTransfer(t, files, -1, singleSegment(-1), false)
			response, err = m.request(t.ctx, http.MethodGet, probe.url, "", "")
			if err == nil {
				defer response.close()
				err = m.downloadSingle(t, files, response)
			}
		}
	} else {
		err = m.downloadSingle(t, files, response)
	}
	if err != nil {
		return files, err
	}
	m.mu.Lock()
	done, total := t.snapshot.Done, t.snapshot.Total
	m.mu.Unlock()
	if total >= 0 && done != total {
		return files, fmt.Errorf("incomplete response: wrote %d of %d bytes: %w", done, total, io.ErrUnexpectedEOF)
	}
	info, err := files.file.Stat()
	if err != nil {
		return files, fmt.Errorf("stat download: %w", err)
	}
	if info.Size() != done {
		return files, fmt.Errorf("incomplete file: size %d, wrote %d bytes", info.Size(), done)
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

func (m *Manager) startTransfer(t *runtimeTask, files *ownedFiles, total int64, segments []SegmentSnapshot, resumable bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t.snapshot.FileName, t.snapshot.SavePath = filepath.Base(files.target), files.target
	t.snapshot.Total, t.snapshot.Done = total, 0
	t.snapshot.Speed, t.snapshot.EtaSec = 0, -1
	t.snapshot.Segments, t.snapshot.Resumable = segments, resumable
	t.snapshot.Status = StatusDownloading
	t.lastDone, t.lastSample, t.speed = 0, time.Now(), 0
	refreshSegments(&t.snapshot)
	m.emitLocked(EvStatus, t)
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
