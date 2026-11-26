package downloader

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestProbeFallbackAndSingleStreamSelection(t *testing.T) {
	large := testPayload(2*1024*1024 + 19)
	modified := time.Unix(1445412480, 0).UTC().Format(http.TimeFormat)
	for _, tc := range []struct {
		name                                                                 string
		headCode                                                             int
		missingLength, advertise, ignoreRange, weak, lastModified, validator bool
		size                                                                 int
		wantCount, wantProbes, wantFull                                      int
	}{
		{name: "head_405", headCode: 405, validator: true, size: len(large), wantCount: 3, wantProbes: 1},
		{name: "head_501", headCode: 501, validator: true, size: len(large), wantCount: 3, wantProbes: 1},
		{name: "missing_length", missingLength: true, validator: true, size: len(large), wantCount: 3, wantProbes: 1},
		{name: "no_ranges", validator: true, size: len(large), wantCount: 1, wantFull: 1},
		{name: "head_capability_unconfirmed", advertise: true, ignoreRange: true, validator: true, size: len(large), wantCount: 1, wantProbes: 1},
		{name: "no_validator", advertise: true, size: len(large), wantCount: 1, wantFull: 1},
		{name: "weak_etag", advertise: true, validator: true, weak: true, size: len(large), wantCount: 1, wantFull: 1},
		{name: "weak_etag_not_date_if_range", advertise: true, validator: true, weak: true, lastModified: true, size: len(large), wantCount: 1, wantFull: 1},
		{name: "last_modified", advertise: true, lastModified: true, size: len(large), wantCount: 3, wantProbes: 1},
		{name: "probe_without_validator", headCode: 405, size: len(large), wantCount: 1, wantProbes: 1, wantFull: 1},
		{name: "small", advertise: true, validator: true, size: 123, wantCount: 1, wantFull: 1},
		{name: "one_mib", advertise: true, validator: true, size: 1024 * 1024, wantCount: 1, wantFull: 1},
		{name: "unknown_range_ignored", headCode: 405, ignoreRange: true, missingLength: true, size: 177, wantCount: 1, wantProbes: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload := large[:tc.size]
			var heads, probes, fulls, workers atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.validator {
					etag := `"version-one"`
					if tc.weak {
						etag = `W/"version-one"`
					}
					w.Header().Set("ETag", etag)
				}
				if tc.lastModified {
					w.Header().Set("Last-Modified", modified)
				}
				if r.Method == http.MethodHead {
					heads.Add(1)
					if tc.advertise {
						w.Header().Set("Accept-Ranges", "bytes")
					}
					if !tc.missingLength {
						w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
					}
					if tc.headCode != 0 {
						w.WriteHeader(tc.headCode)
					} else {
						w.WriteHeader(200)
					}
					if tc.missingLength {
						w.(http.Flusher).Flush()
					}
					return
				}
				if r.Header.Get("Range") != "" {
					start, end := testRange(t, r, len(payload))
					if start == 0 && end == 0 {
						probes.Add(1)
					} else {
						workers.Add(1)
					}
					if tc.weak && r.Header.Get("If-Range") == `W/"version-one"` {
						t.Error("weak ETag sent as If-Range")
					}
					if tc.lastModified && r.Header.Get("If-Range") != "" && r.Header.Get("If-Range") != modified {
						t.Errorf("If-Range=%q want Last-Modified", r.Header.Get("If-Range"))
					}
					if !tc.ignoreRange {
						writeTestRange(w, payload, start, end)
						return
					}
				} else {
					fulls.Add(1)
				}
				if tc.missingLength && tc.ignoreRange {
					w.WriteHeader(200)
					w.(http.Flusher).Flush()
				} else {
					w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
				}
				_, _ = w.Write(payload)
			}))
			t.Cleanup(server.Close)
			m := testManager(t, Config{})
			dir := t.TempDir()
			s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/probe.bin", dir))
			if s.Status != StatusCompleted || s.SegCount != tc.wantCount || s.Resumable != (tc.wantCount > 1) || s.Done != int64(len(payload)) {
				t.Fatalf("selection failed: %+v", s)
			}
			if heads.Load() != 1 || int(probes.Load()) != tc.wantProbes || int(fulls.Load()) != tc.wantFull || (tc.wantCount > 1 && int(workers.Load()) != tc.wantCount) {
				t.Errorf("HEAD=%d probe=%d full=%d workers=%d", heads.Load(), probes.Load(), fulls.Load(), workers.Load())
			}
			got, err := os.ReadFile(s.SavePath)
			if err != nil || sha256.Sum256(got) != sha256.Sum256(payload) {
				t.Fatalf("SHA256 mismatch: %v", err)
			}
		})
	}
}

func TestRangeProbeRejectsInvalidResponses(t *testing.T) {
	for _, kind := range []string{"start", "end", "total", "unknown_total", "overflow", "unit", "missing", "length", "short", "long", "encoding", "validator"} {
		t.Run(kind, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				rangeHeaders(w, 2*1024*1024)
				if r.Method == http.MethodHead {
					return
				}
				value := "bytes 0-0/2097152"
				switch kind {
				case "start":
					value = "bytes 1-1/2097152"
				case "end":
					value = "bytes 0-1/2097152"
				case "total":
					value = "bytes 0-0/2097153"
				case "unknown_total":
					value = "bytes 0-0/*"
				case "overflow":
					value = "bytes 0-0/9223372036854775808"
				case "unit":
					value = "items 0-0/2097152"
				case "missing":
					value = ""
				case "encoding":
					w.Header().Set("Content-Encoding", "gzip")
				case "validator":
					w.Header().Set("ETag", `"version-two"`)
				}
				w.Header().Set("Content-Range", value)
				w.Header().Set("Content-Length", "1")
				if kind == "length" {
					w.Header().Set("Content-Length", "2")
				}
				if kind == "long" {
					w.Header().Del("Content-Length")
				}
				w.WriteHeader(http.StatusPartialContent)
				if kind == "short" {
					return
				}
				if kind == "long" {
					w.(http.Flusher).Flush()
					_, _ = w.Write([]byte{1, 2})
					return
				}
				_, _ = w.Write([]byte{1})
			}))
			t.Cleanup(server.Close)
			m := testManager(t, Config{})
			dir := t.TempDir()
			s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/bad-probe.bin", dir))
			if s.Status != StatusFailed || s.Error == "" {
				t.Fatalf("invalid probe accepted: %+v", s)
			}
			assertFiles(t, dir, nil)
		})
	}
}

func TestContentRangeParserStrictness(t *testing.T) {
	for _, value := range []string{"bytes 0-0/1", "bytes 17-99/100", fmt.Sprintf("bytes 0-%d/%d", int64(math.MaxInt64-1), int64(math.MaxInt64))} {
		start, end, total, err := parseContentRange(value)
		if err != nil || start < 0 || start > end || end >= total {
			t.Errorf("valid range %q: %d %d %d %v", value, start, end, total, err)
		}
	}
	for _, value := range []string{"", "bytes */100", "bytes 0-0/*", "bytes 0-1/1", "bytes 2-1/3", "bytes -1-0/3", "bytes +0-1/3", "bytes 0-0/0", "bytes 0-0/-1", "bytes 0-0/9223372036854775808", "bytes 0-0/1, 2-2/3", "bytes  0-0/1", "bytes 0-0/1 ", "items 0-0/1"} {
		if _, _, _, err := parseContentRange(value); err == nil {
			t.Errorf("accepted invalid range %q", value)
		}
	}
}

func TestSegmentsConfigurationDefaultClampAndValidation(t *testing.T) {
	for _, tc := range []struct{ input, want int }{{0, 8}, {-2, 8}, {1, 1}, {17, 17}, {33, 32}, {math.MaxInt, 32}} {
		m := testManager(t, Config{SegmentsPerFile: tc.input})
		if m.segmentsPerFile != tc.want {
			t.Errorf("config %d got %d want %d", tc.input, m.segmentsPerFile, tc.want)
		}
	}
	m := testManager(t, Config{})
	dir := t.TempDir()
	for _, value := range []int{-1, 33, math.MaxInt} {
		if id, err := m.Add(context.Background(), AddRequest{URL: "https://example.invalid/a", SaveDir: dir, Segments: value}); err == nil || id != "" || !strings.Contains(err.Error(), "segments") {
			t.Errorf("invalid segments %d accepted: %s %v", value, id, err)
		}
	}
	if len(m.Snapshot()) != 0 {
		t.Error("invalid segments created tasks")
	}
}

func TestValidatorSelectionNeverUsesWeakOrMalformedETag(t *testing.T) {
	modified := time.Unix(1445412480, 0).UTC().Format(http.TimeFormat)
	for _, etag := range []string{`W/"weak"`, `unquoted`, `"bad"quote"`, "\"bad\x01\"", ""} {
		h := make(http.Header)
		h.Set("ETag", etag)
		if v := responseValidator(h); v.value != "" {
			t.Errorf("used unusable ETag %q: %+v", etag, v)
		}
		h.Set("Last-Modified", "not-a-date")
		if v := responseValidator(h); v.value != "" {
			t.Errorf("used invalid date: %+v", v)
		}
		h.Set("Last-Modified", modified)
		h.Set("Date", time.Unix(1445412480+60, 0).UTC().Format(http.TimeFormat))
		if v := responseValidator(h); etag != "" && v.value != "" {
			t.Errorf("date If-Range used despite unusable entity tag: %+v", v)
		}
		h.Del("ETag")
		if v := responseValidator(h); v.header != "Last-Modified" || v.value != modified {
			t.Errorf("missing qualified date fallback: %+v", v)
		}
	}
	h := make(http.Header)
	h.Set("ETag", `"strong"`)
	h.Set("Last-Modified", modified)
	if v := responseValidator(h); v.header != "ETag" || v.value != `"strong"` {
		t.Errorf("strong ETag not preferred: %+v", v)
	}
}

func TestLastModifiedMustBeQualifiedByServerDate(t *testing.T) {
	modified := time.Unix(1445412480, 0).UTC()
	for _, delta := range []time.Duration{-time.Second, 0, time.Second, 59 * time.Second, time.Minute, time.Hour} {
		h := make(http.Header)
		h.Set("Last-Modified", modified.Format(http.TimeFormat))
		h.Set("Date", modified.Add(delta).Format(http.TimeFormat))
		v := responseValidator(h)
		if (v.value != "") != (delta >= time.Minute) {
			t.Errorf("server date age %s: validator=%+v", delta, v)
		}
	}
	for _, date := range []string{"", "not-a-date"} {
		h := make(http.Header)
		h.Set("Last-Modified", modified.Format(http.TimeFormat))
		h.Set("Date", date)
		if v := responseValidator(h); v.value != "" {
			t.Errorf("unqualified date accepted: %+v", v)
		}
	}
}

func TestHeadContentDispositionPreservedWhenGETOmitsIt(t *testing.T) {
	for _, size := range []int{17, 2 * 1024 * 1024} {
		t.Run(strconv.Itoa(size), func(t *testing.T) {
			payload := testPayload(size)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				rangeHeaders(w, len(payload))
				if r.Method == http.MethodHead {
					w.Header().Set("Content-Disposition", `attachment; filename="from-head.bin"`)
					return
				}
				if r.Header.Get("Range") != "" {
					start, end := testRange(t, r, len(payload))
					writeTestRange(w, payload, start, end)
					return
				}
				_, _ = w.Write(payload)
			}))
			t.Cleanup(server.Close)
			m := testManager(t, Config{})
			s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/url-name.bin", t.TempDir()))
			if s.Status != StatusCompleted || s.FileName != "from-head.bin" {
				t.Fatalf("HEAD filename lost: %+v", s)
			}
		})
	}
}

func TestSameSecondLastModifiedChangeUsesCoherentSingleStream(t *testing.T) {
	old := bytes.Repeat([]byte{3}, 2*1024*1024)
	fresh := bytes.Repeat([]byte{17}, len(old))
	modified := time.Now().UTC().Truncate(time.Second)
	for _, kind := range []string{"same_second", "missing_date", "recent_date", "weak_etag"} {
		t.Run(kind, func(t *testing.T) {
			var ranges, fulls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Length", strconv.Itoa(len(old)))
				w.Header().Set("Accept-Ranges", "bytes")
				w.Header().Set("Last-Modified", modified.Format(http.TimeFormat))
				w.Header().Set("Date", modified.Format(http.TimeFormat))
				switch kind {
				case "missing_date":
					w.Header()["Date"] = nil
				case "recent_date":
					w.Header().Set("Date", modified.Add(time.Second).Format(http.TimeFormat))
				case "weak_etag":
					w.Header().Set("Date", modified.Add(time.Hour).Format(http.TimeFormat))
					w.Header().Set("ETag", `W/"same-weak-tag"`)
				}
				if r.Method == http.MethodHead {
					return
				}
				if r.Header.Get("Range") != "" {
					ranges.Add(1)
					start, end := testRange(t, r, len(old))
					// Both versions legitimately share a weak, second-resolution
					// timestamp. Only a single response is a coherent representation.
					data := old
					if start > 0 {
						data = fresh
					}
					writeTestRange(w, data, start, end)
					return
				}
				fulls.Add(1)
				_, _ = w.Write(fresh)
			}))
			t.Cleanup(server.Close)
			m := testManager(t, Config{SegmentsPerFile: 2})
			s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/changing.bin", t.TempDir()))
			if s.Status != StatusCompleted || s.SegCount != 1 || s.Resumable || ranges.Load() != 0 || fulls.Load() != 1 {
				t.Fatalf("weak date used for concurrent representation: %+v ranges=%d fulls=%d", s, ranges.Load(), fulls.Load())
			}
			got, err := os.ReadFile(s.SavePath)
			if err != nil || sha256.Sum256(got) != sha256.Sum256(fresh) {
				t.Fatalf("mixed same-second versions: %v", err)
			}
		})
	}
}

func TestLastModifiedSegmentsRequireConsistentQualifiedValidator(t *testing.T) {
	payload := testPayload(2 * 1024 * 1024)
	modified := time.Unix(1445412480, 0).UTC()
	for _, kind := range []string{"missing_date", "recent_date", "etag_introduced", "modified_changed"} {
		t.Run(kind, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
				w.Header().Set("Accept-Ranges", "bytes")
				w.Header().Set("Last-Modified", modified.Format(http.TimeFormat))
				w.Header().Set("Date", modified.Add(time.Minute).Format(http.TimeFormat))
				if r.Method == http.MethodHead {
					return
				}
				start, end := testRange(t, r, len(payload))
				if end != 0 {
					if r.Header.Get("If-Range") != modified.Format(http.TimeFormat) {
						t.Error("qualified Last-Modified not sent in If-Range")
					}
					switch kind {
					case "missing_date":
						w.Header()["Date"] = nil
					case "recent_date":
						w.Header().Set("Date", modified.Format(http.TimeFormat))
					case "etag_introduced":
						w.Header().Set("ETag", `"new-tag"`)
					case "modified_changed":
						w.Header().Set("Last-Modified", modified.Add(-time.Hour).Format(http.TimeFormat))
					}
				}
				writeTestRange(w, payload, start, end)
			}))
			t.Cleanup(server.Close)
			m := testManager(t, Config{SegmentsPerFile: 2})
			dir := t.TempDir()
			s := waitTask(t, m, addTask(t, m, context.Background(), server.URL+"/date.bin", dir))
			if s.Status != StatusFailed || !strings.Contains(s.Error, "validator") {
				t.Fatalf("unqualified range accepted: %+v", s)
			}
			assertFiles(t, dir, nil)
		})
	}
}
