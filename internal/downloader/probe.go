package downloader

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tuanhuynh1704/Go-Get-Wails_v2/internal/util"
)

type representationValidator struct {
	header string
	value  string
}

func responseValidator(h http.Header) representationValidator {
	etag := h.Get("ETag")
	if len(etag) >= 2 && etag[0] == '"' && etag[len(etag)-1] == '"' {
		valid := true
		for _, c := range []byte(etag[1 : len(etag)-1]) {
			if c < 0x21 || c == '"' || c == 0x7f {
				valid = false
			}
		}
		if valid {
			return representationValidator{"ETag", etag}
		}
	}
	// Date-based If-Range requires a strong date and no entity tag (RFC 9110,
	// 8.8.2.2/13.1.5). Conservatively require a minute between server timestamps.
	// Recent/missing Date or an unusable ETag deliberately selects one stream.
	if modified := h.Get("Last-Modified"); etag == "" && modified != "" {
		lastModified, modifiedErr := http.ParseTime(modified)
		date, dateErr := http.ParseTime(h.Get("Date"))
		if modifiedErr == nil && dateErr == nil && date.Sub(lastModified) >= time.Minute {
			return representationValidator{"Last-Modified", modified}
		}
	}
	return representationValidator{}
}

func (v representationValidator) validate(h http.Header) error {
	if v.value != "" && (h.Get(v.header) != v.value || responseValidator(h) != v) {
		return fmt.Errorf("representation validator changed or missing: %s", v.header)
	}
	return nil
}

type probeResult struct {
	url       string
	name      string
	total     int64
	ranges    bool
	validator representationValidator
	full      *transferResponse
}

func responseURL(resp *http.Response, fallback string) string {
	if resp.Request != nil && resp.Request.URL != nil {
		return resp.Request.URL.String()
	}
	return fallback
}

func (m *Manager) probe(t *runtimeTask) (*probeResult, error) {
	head, err := m.request(t.ctx, http.MethodHead, t.snapshot.URL, "", "")
	if err != nil {
		return nil, err
	}
	p := &probeResult{url: responseURL(head.Response, t.snapshot.URL), total: -1}
	p.name = util.FileName(head.Header.Get("Content-Disposition"), p.url)
	fallback := head.StatusCode == http.StatusMethodNotAllowed || head.StatusCode == http.StatusNotImplemented
	if !fallback {
		if head.StatusCode != http.StatusOK {
			head.close()
			return nil, fmt.Errorf("HTTP %d %s", head.StatusCode, http.StatusText(head.StatusCode))
		}
		if err := identityEncoding(head.Response); err != nil {
			head.close()
			return nil, err
		}
		p.total, p.validator = head.ContentLength, responseValidator(head.Header)
		advertised := strings.EqualFold(strings.TrimSpace(head.Header.Get("Accept-Ranges")), "bytes")
		fallback = p.total < 0 || (advertised && p.validator.value != "" && segmentCount(p.total, t.requestedSegments) > 1)
	}
	head.close()
	if !fallback {
		return p, nil
	}
	// Advertised HEAD capability is only a hint. Confirm with an actual 206.
	response, err := m.request(t.ctx, http.MethodGet, p.url, "bytes=0-0", p.validator.value)
	if err != nil {
		return nil, err
	}
	if err := identityEncoding(response.Response); err != nil {
		response.close()
		return nil, err
	}
	finalURL := responseURL(response.Response, p.url)
	if response.Header.Get("Content-Disposition") != "" || finalURL != p.url {
		p.name = util.FileName(response.Header.Get("Content-Disposition"), finalURL)
	}
	p.url = finalURL
	if response.StatusCode == http.StatusOK {
		// A range-ignoring probe already is a complete single-stream response.
		p.total, p.full = response.ContentLength, response
		return p, nil
	}
	defer response.close()
	if response.StatusCode != http.StatusPartialContent {
		return nil, fmt.Errorf("HTTP %d %s", response.StatusCode, http.StatusText(response.StatusCode))
	}
	start, end, total, err := parseContentRange(response.Header.Get("Content-Range"))
	if err != nil || start != 0 || end != 0 || (p.total >= 0 && p.total != total) {
		return nil, fmt.Errorf("invalid probe Content-Range: %q", response.Header.Get("Content-Range"))
	}
	if err := p.validator.validate(response.Header); err != nil {
		return nil, err
	}
	if response.ContentLength >= 0 && response.ContentLength != 1 {
		return nil, fmt.Errorf("invalid probe Content-Length: %d", response.ContentLength)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 2))
	if err = response.readError(err); err != nil {
		return nil, fmt.Errorf("read range probe: %w", err)
	}
	if len(data) != 1 {
		return nil, fmt.Errorf("incomplete range probe: got %d bytes, want 1", len(data))
	}
	p.total, p.validator = total, responseValidator(response.Header)
	// Without a usable representation validator, concurrent requests could mix
	// versions despite matching lengths. Deliberately use a single stream.
	p.ranges = p.validator.value != ""
	return p, nil
}

// parseContentRange accepts only a single, satisfied byte interval with a known
// positive total. ParseInt rejects overflow before any offset arithmetic.
func parseContentRange(value string) (start, end, total int64, err error) {
	invalid := func() (int64, int64, int64, error) {
		return 0, 0, 0, fmt.Errorf("invalid Content-Range: %q", value)
	}
	if !strings.HasPrefix(value, "bytes ") {
		return invalid()
	}
	rangePart, totalPart, ok := strings.Cut(strings.TrimPrefix(value, "bytes "), "/")
	if !ok {
		return invalid()
	}
	startPart, endPart, ok := strings.Cut(rangePart, "-")
	if !ok {
		return invalid()
	}
	parts := []string{startPart, endPart, totalPart}
	numbers := make([]int64, 3)
	for i, part := range parts {
		if part == "" {
			return invalid()
		}
		for _, c := range part {
			if c < '0' || c > '9' {
				return invalid()
			}
		}
		numbers[i], err = strconv.ParseInt(part, 10, 64)
		if err != nil {
			return invalid()
		}
	}
	start, end, total = numbers[0], numbers[1], numbers[2]
	if total <= 0 || start > end || end >= total {
		return invalid()
	}
	return start, end, total, nil
}
