package dto

type TaskDTO struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	FileName  string `json:"fileName"`
	Category  string `json:"category"`
	SaveDir   string `json:"saveDir"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
	Total     int64  `json:"total"`
	Done      int64  `json:"done"`
	Speed     int64  `json:"speed"`
	EtaSec    int64  `json:"etaSec"`
	SegCount  int    `json:"segCount"`
	Resumable bool   `json:"resumable"`
	Segs      []int  `json:"segs"`
	CreatedAt int64  `json:"createdAt"`
}

type SegmentDTO struct {
	Index  int    `json:"index"`
	Start  int64  `json:"start"`
	End    int64  `json:"end"`
	Done   int64  `json:"done"`
	Status string `json:"status"`
}

type TaskDetail struct {
	Task     TaskDTO      `json:"task"`
	Segments []SegmentDTO `json:"segments"`
}

type ProgressItem struct {
	ID     string `json:"id"`
	Done   int64  `json:"done"`
	Total  int64  `json:"total"`
	Speed  int64  `json:"speed"`
	EtaSec int64  `json:"etaSec"`
	// Use integers: encoding/json encodes []uint8 as base64, not a JSON array.
	Segs []int `json:"segs"`
}

type ProgressBatch struct {
	Items []ProgressItem `json:"items"`
}

type Stats struct {
	GlobalSpeed int64 `json:"globalSpeed"`
	Active      int   `json:"active"`
	Queued      int   `json:"queued"`
}

type Snapshot struct {
	Tasks []TaskDTO `json:"tasks"`
	Stats Stats     `json:"stats"`
}

type AddRequest struct {
	URLs     []string `json:"urls"`
	SaveDir  string   `json:"saveDir"`
	Segments int      `json:"segments"`
}

type AddError struct {
	URL   string `json:"url"`
	Error string `json:"error"`
}

type AddResult struct {
	IDs    []string   `json:"ids"`
	Errors []AddError `json:"errors"`
}

type Settings struct {
	DownloadDir        string `json:"downloadDir"`
	MaxConcurrentFiles int    `json:"maxConcurrentFiles"`
	SegmentsPerFile    int    `json:"segmentsPerFile"`
}
