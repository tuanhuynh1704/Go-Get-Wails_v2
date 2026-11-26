package dto

type TaskDTO struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	FileName  string `json:"fileName"`
	SaveDir   string `json:"saveDir"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
	Total     int64  `json:"total"`
	Done      int64  `json:"done"`
	Speed     int64  `json:"speed"`
	EtaSec    int64  `json:"etaSec"`
	SegCount  int    `json:"segCount"`
	Resumable bool   `json:"resumable"`
	CreatedAt int64  `json:"createdAt"`
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
	URLs    []string `json:"urls"`
	SaveDir string   `json:"saveDir"`
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
