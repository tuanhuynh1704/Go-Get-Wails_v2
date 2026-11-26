package downloader

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"sync"

	"github.com/tuanhuynh1704/Go-Get-Wails_v2/internal/util"
)

const minSegmentSize int64 = 1024 * 1024

var errRangeIgnored = errors.New("server ignored Range")

func segmentCount(total int64, requested int) int {
	if total <= 0 {
		return 1
	}
	// (total + min - 1) / min would overflow near MaxInt64.
	return int(min(int64(max(1, min(32, requested))), (total-1)/minSegmentSize+1))
}

func split(total int64, requested int) []SegmentSnapshot {
	if total <= 0 {
		return nil
	}
	n := segmentCount(total, requested)
	size := total / int64(n)
	segments := make([]SegmentSnapshot, n)
	for i := range segments {
		start := int64(i) * size
		end := start + size - 1
		if i == n-1 {
			end = total - 1
		}
		segments[i] = SegmentSnapshot{Index: i, Start: start, End: end, Status: string(StatusQueued)}
	}
	return segments
}

func singleSegment(total int64) []SegmentSnapshot {
	end := int64(-1)
	if total > 0 {
		end = total - 1
	}
	return []SegmentSnapshot{{Index: 0, End: end, Status: string(StatusDownloading)}}
}

func responseFileName(response *http.Response, fallback string) string {
	return util.FileName(response.Header.Get("Content-Disposition"), responseURL(response, fallback))
}

func validateFullResponse(response *transferResponse) error {
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d %s", response.StatusCode, http.StatusText(response.StatusCode))
	}
	return identityEncoding(response.Response)
}

func (m *Manager) downloadSingle(t *runtimeTask, files *ownedFiles, response *transferResponse) error {
	if err := validateFullResponse(response); err != nil {
		return err
	}
	if response.ContentLength >= 0 {
		if err := files.file.Truncate(response.ContentLength); err != nil {
			return fmt.Errorf("allocate download: %w", err)
		}
	}
	m.startTransfer(t, files, response.ContentLength, singleSegment(response.ContentLength), false)
	return m.readSegment(t, files.file, response, 0, 0, response.ContentLength)
}

func (m *Manager) downloadSegments(t *runtimeTask, file *os.File, probe *probeResult) error {
	ctx, cancel := context.WithCancelCause(t.ctx)
	defer cancel(nil)
	var wg sync.WaitGroup
	var first error
	var errMu sync.Mutex
	// Copy fixed boundaries before launching workers; snapshots remain mutable.
	m.mu.Lock()
	segments := append([]SegmentSnapshot(nil), t.snapshot.Segments...)
	m.mu.Unlock()
	for _, segment := range segments {
		wg.Add(1)
		go func(segment SegmentSnapshot) {
			defer wg.Done()
			err := m.downloadSegment(ctx, t, file, probe, segment)
			if err != nil {
				errMu.Lock()
				if first == nil {
					first = err
					cancel(err)
				}
				errMu.Unlock()
			}
		}(segment)
	}
	wg.Wait()
	return first
}

func (m *Manager) downloadSegment(ctx context.Context, t *runtimeTask, file *os.File, probe *probeResult, segment SegmentSnapshot) (err error) {
	m.mu.Lock()
	t.snapshot.Segments[segment.Index].Status = string(StatusDownloading)
	m.mu.Unlock()
	defer func() {
		if err != nil {
			m.mu.Lock()
			status := StatusFailed
			if ctx.Err() != nil {
				status = StatusCanceled
			}
			t.snapshot.Segments[segment.Index].Status = string(status)
			refreshSegments(&t.snapshot)
			m.mu.Unlock()
		}
	}()
	response, err := m.request(ctx, http.MethodGet, probe.url, fmt.Sprintf("bytes=%d-%d", segment.Start, segment.End), probe.validator.value)
	if err != nil {
		return err
	}
	defer response.close()
	if response.StatusCode == http.StatusOK {
		return errRangeIgnored
	}
	if response.StatusCode != http.StatusPartialContent {
		return fmt.Errorf("HTTP %d %s", response.StatusCode, http.StatusText(response.StatusCode))
	}
	if err := identityEncoding(response.Response); err != nil {
		return err
	}
	// Entity tags identify versions of one resource, not every server resource.
	// Range-dependent redirects could otherwise splice unrelated entities with
	// the same tag and size.
	if responseURL(response.Response, probe.url) != probe.url {
		return fmt.Errorf("segment final URL differs from confirmed representation")
	}
	start, end, total, err := parseContentRange(response.Header.Get("Content-Range"))
	if err != nil || start != segment.Start || end != segment.End || total != probe.total {
		return fmt.Errorf("invalid segment Content-Range: %q", response.Header.Get("Content-Range"))
	}
	if err := probe.validator.validate(response.Header); err != nil {
		return err
	}
	length := segment.End - segment.Start + 1
	if response.ContentLength >= 0 && response.ContentLength != length {
		return fmt.Errorf("invalid segment Content-Length: %d, want %d", response.ContentLength, length)
	}
	return m.readSegment(t, file, response, segment.Index, segment.Start, length)
}

func (m *Manager) readSegment(t *runtimeTask, file *os.File, response *transferResponse, index int, start, length int64) error {
	buf := make([]byte, 64*1024)
	var done int64
	for {
		if err := response.readError(nil); err != nil {
			return err
		}
		readBuf := buf
		if length >= 0 && length-done < int64(len(buf)) {
			// Read one extra byte to reject oversized chunked/custom responses.
			readBuf = buf[:length-done+1]
		}
		n, readErr := response.Body.Read(readBuf)
		if n > 0 {
			if int64(n) > math.MaxInt64-start-done || (length >= 0 && int64(n) > length-done) {
				return fmt.Errorf("incomplete response: body exceeds expected length")
			}
			written, writeErr := file.WriteAt(buf[:n], start+done)
			done += int64(written)
			m.mu.Lock()
			t.snapshot.Done += int64(written)
			t.snapshot.Segments[index].Done = done
			refreshSegments(&t.snapshot)
			m.mu.Unlock()
			if writeErr != nil {
				return fmt.Errorf("write download: %w", writeErr)
			}
			if written != n {
				return io.ErrShortWrite
			}
		}
		if readErr = response.readError(readErr); readErr != nil {
			if readErr != io.EOF {
				return fmt.Errorf("read download: %w", readErr)
			}
			if length >= 0 && done != length {
				return fmt.Errorf("incomplete response: wrote %d of %d bytes: %w", done, length, io.ErrUnexpectedEOF)
			}
			m.mu.Lock()
			t.snapshot.Segments[index].Status = string(StatusCompleted)
			refreshSegments(&t.snapshot)
			m.mu.Unlock()
			return nil
		}
	}
}
