package downloader

import (
	"math"
	"time"
)

func refreshSegments(s *TaskSnapshot) {
	s.SegCount = len(s.Segments)
	if len(s.Segs) != len(s.Segments) {
		s.Segs = make([]int, len(s.Segments))
	}
	for i, segment := range s.Segments {
		percent := 0
		length := segment.End - segment.Start + 1
		if segment.Status == string(StatusCompleted) || (length > 0 && segment.Done >= length) {
			percent = 100
		} else if length > 0 && segment.Done > 0 {
			// Avoid overflowing int64 for very large files, and rounding an
			// incomplete segment to 100 percent through floating point precision.
			percent = min(99, int(float64(segment.Done)/float64(length)*100))
		}
		s.Segs[i] = percent
	}
}

func sampleProgress(t *runtimeTask, now time.Time) {
	if seconds := now.Sub(t.lastSample).Seconds(); seconds > 0 {
		instant := float64(max(0, t.snapshot.Done-t.lastDone)) / seconds
		t.speed = 0.3*instant + 0.7*t.speed
		t.snapshot.Speed = boundedInt(t.speed)
		t.snapshot.EtaSec = -1
		if t.snapshot.Total >= 0 && t.snapshot.Speed > 0 {
			t.snapshot.EtaSec = boundedInt(math.Ceil(float64(max(0, t.snapshot.Total-t.snapshot.Done)) / float64(t.snapshot.Speed)))
		}
		t.lastDone, t.lastSample = t.snapshot.Done, now
	}
	refreshSegments(&t.snapshot)
}

func boundedInt(value float64) int64 {
	if value >= float64(math.MaxInt64) {
		return math.MaxInt64
	}
	return int64(value)
}
