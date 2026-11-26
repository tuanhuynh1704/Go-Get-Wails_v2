# GoGet - Tài liệu thiết kế chi tiết (Wails v2)

GoGet là trình quản lý tải file kiểu IDM. Lõi tải viết bằng Go, giao diện viết bằng React + TypeScript, ghép lại bằng **Wails v2**. README.md cho cái nhìn tổng quan; tài liệu này đi sâu vào kiến trúc, giao tiếp Go ↔ frontend, thuật toán tải, đồng thời, lưu trữ, giao diện, đóng gói, kiểm thử và lộ trình.

> Đây là bản thiết kế ban đầu, chưa có code. Hãy coi nó là bản nháp: các phần chắc chắn là kiến trúc, mô hình dữ liệu, thuật toán tải và hợp đồng Go ↔ frontend. Phần giao diện chi tiết và các tính năng muộn (extension, tray) sẽ đổi khi làm thật.

---

## 1. Mục tiêu và phạm vi

### 1.1 Mục tiêu
- Tải file lớn nhanh hơn bằng cách chia đoạn song song.
- Tạm dừng và tiếp tục được, kể cả sau khi tắt app hoặc mất mạng.
- Quản lý nhiều file với hàng đợi, giới hạn tốc độ, hẹn giờ.
- Giao diện web hiện đại, mượt với hàng trăm Task, hỗ trợ theme sáng/tối.
- Đa nền tảng: Windows 10+, macOS 12+, Ubuntu 22.04+.

### 1.2 Ngoài phạm vi (ít nhất đến v1.0)
- Torrent, FTP, SFTP, magnet link.
- Tự nhận diện video streaming (HLS/DASH).
- Vượt giới hạn truy cập của máy chủ.
- Đồng bộ giữa nhiều máy.

### 1.3 Vì sao Wails v2
| Lợi | Hại / giới hạn cần biết |
|---|---|
| UI bằng web nên đẹp, linh hoạt, hệ sinh thái lớn | Có thêm một toolchain (Node, npm) |
| Binding TypeScript tự sinh từ hàm Go | Mọi dữ liệu qua cầu nối phải JSON-hóa được, có chi phí |
| Dùng WebView hệ thống, file nhỏ, ít RAM hơn Electron | Hành vi WebView khác nhau giữa Windows/macOS/Linux |
| Không cần CGO cho lõi | Không có sẵn system tray và thông báo hệ thống trong v2 |
| `wails dev` hot reload cả Go lẫn frontend | Linux phụ thuộc phiên bản webkit2gtk (4.0 hay 4.1) |

---

## 2. Yêu cầu

### 2.1 Chức năng

| Mã | Yêu cầu | Giai đoạn |
|---|---|---|
| F1 | Thêm nhiều URL, tải đồng thời nhiều file | v0.1 |
| F2 | Hiển thị tiến trình từng file | v0.1 |
| F3 | Hủy từng file hoặc tất cả | v0.1 |
| F4 | Chia file thành N đoạn tải song song | v0.2 |
| F5 | Hiển thị tốc độ, ETA, tiến trình từng đoạn | v0.2 |
| F6 | Quay về một luồng nếu máy chủ không hỗ trợ Range | v0.2 |
| F7 | Tạm dừng và tiếp tục | v0.3 |
| F8 | Lưu trạng thái, khôi phục sau khi tắt app | v0.3 |
| F9 | Tự thử lại khi lỗi tạm thời | v0.3 |
| F10 | Bắt URL từ clipboard | v0.4 |
| F11 | Hẹn giờ bắt đầu tải | v0.4 |
| F12 | Giới hạn tốc độ tổng và từng file | v0.4 |
| F13 | Cài đặt, theme, đa ngôn ngữ | v0.4 |
| F14 | Kéo thả link / file danh sách vào cửa sổ | v0.4 |
| F15 | Nhận link từ extension trình duyệt | v0.5 |

### 2.2 Phi chức năng

| Mã | Yêu cầu | Chỉ tiêu |
|---|---|---|
| N1 | Đúng đắn | File tải về khớp byte với bản gốc trong mọi kịch bản |
| N2 | An toàn đồng thời | `go test -race ./...` sạch cảnh báo |
| N3 | Không rò rỉ goroutine | Sau hủy hoặc đóng app, mọi goroutine kết thúc trong 3 giây |
| N4 | UI mượt | Không đứng khi có 500 Task; cầu nối Go → UI tối đa 4 lần/giây cho tiến trình |
| N5 | Bộ nhớ | Không đọc cả file vào RAM; bộ đệm mỗi đoạn 64 KiB |
| N6 | Chịu lỗi | Tắt app đột ngột chỉ mất vài giây tiến trình, không hỏng file |
| N7 | Dung lượng bản cài | Dưới 25 MB (chưa tính WebView2 bootstrapper) |

---

## 3. Kiến trúc tổng thể

### 3.1 Các tầng

```
+------------------------ WebView ------------------------------+
| React components                                              |
|   ^ đọc                       | gọi                           |
| Zustand store  <-- hooks --> lib/api.ts (bọc wailsjs)         |
+---------------------------+----------------+------------------+
                  EventsOn  |                | binding (Promise)
                            |                v
+---------------------------+----------------+------------------+
| app.go  (adapter mỏng)                                        |
|   - các hàm exported = hợp đồng với frontend                  |
|   - Emitter: gom Event -> EventsEmit                          |
+---------------------------+-----------------------------------+
                            v
+---------------------------+-----------------------------------+
| internal/downloader  (Manager, worker, segment, limiter, retry)|
| internal/storage     (SQLite)                                 |
| internal/watcher     (clipboard, scheduler)                   |
| internal/server      (HTTP cục bộ cho extension)              |
+---------------------------------------------------------------+
```

### 3.2 Quy tắc phụ thuộc
- `internal/*` **không** import `github.com/wailsapp/wails`. Chỉ `main.go` và `app.go` (và Emitter) biết Wails.
- `downloader` giao tiếp ra ngoài bằng channel `Event`; không biết gì về JSON hay giao diện.
- `app.go` chỉ chuyển lệnh, đổi kiểu sang `dto`, và không chứa logic tải.
- `watcher` và `server` gọi `Manager.Add(...)` giống như UI, không đi vòng qua frontend.
- Frontend không chứa logic nghiệp vụ tải; nó là hàm của state mà Go gửi lên.

### 3.3 Cấu trúc package

```
goget/
  main.go app.go emitter.go wails.json
  internal/
    downloader/  manager.go worker.go segment.go probe.go task.go
                 retry.go limiter.go progress.go errors.go
    storage/     sqlite.go schema.go
    watcher/     clipboard.go scheduler.go
    server/      local.go auth.go
    config/      config.go
    dto/         dto.go
    util/        filename.go format.go
  frontend/src/
    store/ components/ hooks/ lib/ styles/ locales/
```

---

## 4. Giao tiếp Go ↔ Frontend (hợp đồng)

Đây là phần quan trọng nhất của thiết kế dùng Wails, vì mọi thứ đi qua cầu nối IPC giữa Go và WebView đều tốn chi phí và phải JSON-hóa được.

### 4.1 Hai kênh
- **Lệnh (frontend → Go):** hàm exported của struct `App` được `Bind`. Wails sinh `frontend/wailsjs/go/main/App.{js,d.ts}` và các kiểu TypeScript trong `models.ts`. Mỗi lời gọi trả `Promise`; nếu Go trả `error` thì Promise bị reject với chuỗi lỗi.
- **Sự kiện (Go → frontend):** `runtime.EventsEmit(ctx, name, data)` ở Go, `EventsOn(name, cb)` ở frontend. `EventsEmit` gọi được từ mọi goroutine.

### 4.2 Lệnh (các hàm bind)

```go
// app.go
type App struct {
	ctx context.Context
	mgr *downloader.Manager
	em  *Emitter
	cfg *config.Store
}

// Task
func (a *App) AddURLs(req dto.AddRequest) (dto.AddResult, error)
func (a *App) ListTasks() (dto.Snapshot, error)
func (a *App) GetTaskDetail(id string) (dto.TaskDetail, error) // gồm danh sách đoạn
func (a *App) Pause(id string) error
func (a *App) Resume(id string) error
func (a *App) Cancel(id string, deleteFile bool) error
func (a *App) Retry(id string) error
func (a *App) UpdateURL(id, newURL string) error
func (a *App) Remove(id string, deleteFile bool) error
func (a *App) PauseAll() error
func (a *App) ResumeAll() error

// Hệ thống
func (a *App) PickDirectory() (string, error)        // runtime.OpenDirectoryDialog
func (a *App) RevealInFolder(id string) error        // chỉ cho Task đã biết
func (a *App) OpenFile(id string) error              // chỉ file của Task đã hoàn tất
func (a *App) GetSettings() (dto.Settings, error)
func (a *App) SaveSettings(s dto.Settings) error
func (a *App) SetLimits(globalKiBps, perFileKiBps int64) error
```

Quy ước:
- Mọi tham số là kiểu đơn giản hoặc struct `dto` có thẻ `json`. Không truyền `time.Time` thô (dùng `int64` unix mili giây) và không truyền `error`/channel.
- ID là chuỗi UUID.
- **Không bao giờ nhận đường dẫn tùy ý từ frontend để đọc/ghi/mở file.** `OpenFile` và `RevealInFolder` nhận `id`, Go tự tra đường dẫn. Xem mục 17.
- Số hàm bind giữ nhỏ và có chủ đích; mọi hàm exported trên struct được bind đều lộ ra cho JS.

### 4.3 DTO

```go
// internal/dto/dto.go
type TaskDTO struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	FileName  string `json:"fileName"`
	SaveDir   string `json:"saveDir"`
	Category  string `json:"category"`
	Status    string `json:"status"` // queued|probing|downloading|paused|completed|failed|canceled
	Error     string `json:"error,omitempty"`
	Total     int64  `json:"total"`  // -1 nếu chưa biết
	Done      int64  `json:"done"`
	Speed     int64  `json:"speed"`  // byte/giây, đã làm mượt
	EtaSec    int64  `json:"etaSec"` // -1 nếu chưa biết
	SegCount  int    `json:"segCount"`
	Resumable bool   `json:"resumable"`
	StartAt   int64  `json:"startAt,omitempty"` // unix ms
	CreatedAt int64  `json:"createdAt"`
}

type ProgressItem struct {
	ID     string  `json:"id"`
	Done   int64   `json:"done"`
	Total  int64   `json:"total"`
	Speed  int64   `json:"speed"`
	EtaSec int64   `json:"etaSec"`
	Segs   []uint8 `json:"segs"` // % hoàn thành từng đoạn, 0..100
}

type Snapshot struct {
	Tasks []TaskDTO `json:"tasks"`
	Stats Stats     `json:"stats"`
}

type Stats struct {
	GlobalSpeed int64 `json:"globalSpeed"`
	Active      int   `json:"active"`
	Queued      int   `json:"queued"`
}
```

Frontend nhận các kiểu này dưới dạng interface TypeScript do Wails sinh, nên đổi DTO ở Go thì kiểu ở frontend tự cập nhật khi chạy `wails dev` hoặc `wails generate module`.

### 4.4 Sự kiện

| Tên sự kiện | Dữ liệu | Khi nào phát |
|---|---|---|
| `task:added` | `TaskDTO` | Thêm Task |
| `task:removed` | `{id}` | Xóa Task |
| `task:status` | `TaskDTO` (đầy đủ) | Đổi trạng thái, lỗi, hoàn tất, có kích thước sau probe |
| `tasks:progress` | `{items: ProgressItem[]}` | Gom mỗi 250 ms cho các Task đang tải |
| `stats:update` | `Stats` | Cùng nhịp với `tasks:progress` |
| `clipboard:url` | `{url}` | Watcher thấy link mới |
| `app:toast` | `{level, message}` | Thông báo ngắn cho giao diện |
| `app:second-instance` | `{args}` | Người dùng mở thêm app lần nữa |

### 4.5 Nguyên tắc để cầu nối không nghẽn
1. **Gom (batch):** tiến trình của mọi Task đang tải gộp vào **một** event `tasks:progress` mỗi 250 ms, thay vì một event cho mỗi Task mỗi đoạn.
2. **Trạng thái tuyệt đối, không phải delta:** mỗi event mang giá trị đầy đủ (`done`, `total`...). Event đến trùng hoặc lệch thứ tự vẫn không làm sai state; cái mới nhất thắng.
3. **Event trạng thái không bị bỏ:** `task:status`, `task:added`, `task:removed` gửi ngay. Chỉ `tasks:progress` mới được gộp và bỏ bớt.
4. **Payload nhỏ:** tiến trình từng đoạn gửi dạng `[]uint8` phần trăm, không gửi mốc byte của từng đoạn. Chi tiết đoạn lấy riêng bằng `GetTaskDetail` khi người dùng mở panel.
5. **Chỉ gửi khi có thay đổi:** Task không đổi `done` thì không đưa vào batch.
6. **Không gửi khi cửa sổ bị ẩn/thu nhỏ** (xem mục 15.6) vì không ai nhìn.

### 4.6 Khởi động đồng bộ, tránh mất sự kiện
Lúc frontend mới nạp có thể có event đến trước khi nó lấy xong danh sách. Quy trình:
1. Frontend **đăng ký** `EventsOn` cho mọi event trước.
2. Gọi `ListTasks()` lấy snapshot và nạp vào store.
3. Áp dụng các event đã đến trong lúc chờ (vì event mang trạng thái tuyệt đối, chỉ cần ghi đè theo `id`).

### 4.7 Emitter

```go
// emitter.go
type Emitter struct {
	ctx     context.Context
	mu      sync.Mutex
	pending map[string]dto.ProgressItem // coalesce theo task id
	stats   dto.Stats
	visible atomic.Bool
}

func (e *Emitter) Progress(it dto.ProgressItem) {
	e.mu.Lock()
	e.pending[it.ID] = it // cái mới đè cái cũ
	e.mu.Unlock()
}

func (e *Emitter) Run(ctx context.Context) {
	t := time.NewTicker(250 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			e.flush()
		}
	}
}

func (e *Emitter) flush() {
	e.mu.Lock()
	if len(e.pending) == 0 { e.mu.Unlock(); return }
	items := make([]dto.ProgressItem, 0, len(e.pending))
	for _, it := range e.pending { items = append(items, it) }
	clear(e.pending)
	st := e.stats
	e.mu.Unlock()

	runtime.EventsEmit(e.ctx, "tasks:progress", map[string]any{"items": items})
	runtime.EventsEmit(e.ctx, "stats:update", st)
}
```

Một goroutine "event pump" đọc `Manager.Events()`: với `EvProgress` thì gọi `em.Progress`, với các loại khác thì phát ngay qua `EventsEmit`.

### 4.8 Xử lý lỗi qua cầu nối
- Lỗi mà người dùng cần biết (URL sai, không ghi được thư mục) trả về dưới dạng `error`; frontend bắt `.catch` và hiện toast.
- Lỗi xảy ra bất đồng bộ trong lúc tải đi theo `task:status` với `status: "failed"` và trường `error`.
- Dùng mã lỗi ổn định thay vì chỉ chuỗi tự do (ví dụ `E_RANGE_IGNORED`, `E_DISK_FULL`, `E_LINK_EXPIRED`) để frontend dịch sang đúng ngôn ngữ.

---

## 5. Mô hình dữ liệu (lõi Go)

Các kiểu lõi giữ nguyên bất kể giao diện, và nằm trong `internal/downloader`.

```go
type TaskID string

type Status int

const (
	StatusQueued Status = iota
	StatusProbing
	StatusDownloading
	StatusPaused
	StatusCompleted
	StatusFailed
	StatusCanceled
)

type Task struct {
	ID          TaskID
	URL         string
	FinalURL    string
	Headers     map[string]string // cookie, referer... từ extension, chỉ giữ trong bộ nhớ và bản ghi Task
	FileName    string
	SavePath    string
	TempPath    string // SavePath + ".goget"
	TotalSize   int64  // -1 nếu không biết
	AcceptRange bool
	ETag        string
	LastMod     string
	Segments    []*Segment
	Status      Status
	ErrCode     string
	CreatedAt   time.Time
	StartAt     *time.Time
	Category    string
}

type Segment struct {
	Index    int
	Start    int64
	End      atomic.Int64 // atomic vì work stealing có thể thu hẹp
	Done     atomic.Int64
	Status   SegStatus
	Attempts int
}

func (s *Segment) Cursor() int64    { return s.Start + s.Done.Load() }
func (s *Segment) Remaining() int64 { return s.End.Load() - s.Cursor() + 1 }
```

Lõi dùng `atomic` cho các trường nhiều goroutine cùng đọc/ghi. `TaskDTO` được dựng từ `Task` ở `app.go` hoặc ở một hàm `snapshot()` của Manager; frontend **không bao giờ** thấy `atomic` hay con trỏ.

---

## 6. Máy trạng thái của Task

```
          Add()
            v
        [Queued] --(chưa tới giờ hẹn)--> [Queued]
            | worker nhận job
            v
        [Probing] --lỗi probe--> [Failed]
            v
      [Downloading] --Pause()--> [Paused] --Resume()--> [Queued]
        |      |  \
        |      |   `--Cancel()--> [Canceled]
        |      `--hết retry--> [Failed] --Retry()--> [Queued]
        v
    [Completed]
```

- Chỉ `Manager` đổi trạng thái, qua một hàm `setStatus` có khóa: ghi SQLite, phát `EvStatus`.
- `Pause` giữ file tạm và trạng thái đoạn; `Cancel` xóa file tạm và bản ghi.
- `Resume` đưa Task về `Queued` để worker pool lập lịch lại.

---

## 7. Thiết kế đồng thời

### 7.1 Bản đồ goroutine

| Goroutine | Số lượng | Vòng đời | Nhiệm vụ |
|---|---|---|---|
| Luồng UI của Wails/WebView | do Wails quản lý | Cả app | Không động vào |
| Event pump | 1 | Cả app | Đọc `Manager.Events()`, chuyển cho Emitter |
| Emitter ticker | 1 | Cả app | Mỗi 250 ms gom và `EventsEmit` |
| File worker | `MaxConcurrentFiles` (mặc định 3) | Cả app | Nhận Task từ `jobs` |
| Segment goroutine | `Segments` mỗi file (mặc định 8) | Một lần tải | Tải một đoạn |
| Progress aggregator | 1 mỗi file đang tải | Một lần tải | Tick 200 ms: gom `Done`, tính tốc độ |
| Persist ticker | 1 mỗi file đang tải | Một lần tải | Tick 2 s: ghi trạng thái đoạn vào SQLite |
| Clipboard watcher | 1 | Cả app | Poll mỗi 700 ms |
| Scheduler | 1 | Cả app | Quản lý hẹn giờ |
| HTTP server | 1 + theo kết nối | Cả app | Nhận link từ extension |

### 7.2 Channel và khóa

```go
type Manager struct {
	jobs    chan *Task // có đệm
	events  chan Event // có đệm, ví dụ 256
	rootCtx context.Context
	cancel  context.CancelCauseFunc
	wg      sync.WaitGroup

	mu    sync.RWMutex
	tasks map[TaskID]*runtimeTask
}
```

- `jobs` có đệm để `Add()` không chặn khi mọi worker bận.
- Với `events`: `EvProgress` được bỏ bớt khi đầy (chỉ cái mới nhất có giá trị); `EvStatus`, `EvDone`, `EvError` gửi chặn có timeout an toàn.

### 7.3 Cây context

```
rootCtx (do App tạo trong OnStartup, KHÔNG dùng ctx của Wails làm gốc cho lõi)
  └── taskCtx (mỗi Task)      <- Pause/Cancel hủy ở đây
        └── segCtx (mỗi đoạn) <- hủy một đoạn lỗi mà không dừng cả file
```

`ctx` mà Wails đưa vào `OnStartup` dùng cho các hàm `runtime.*` (EventsEmit, dialog...). Lõi tải nên có `rootCtx` riêng do `App` tạo (`context.WithCancelCause(context.Background())`) để vòng đời của nó độc lập với Wails và dễ test.

Lý do hủy phân biệt bằng `context.WithCancelCause`: `ErrPaused`, `ErrCanceled`, `ErrShutdown`.

### 7.4 Vòng đời một file

```go
func (w *worker) run(t *Task) {
	ctx, cancel := context.WithCancelCause(w.mgr.rootCtx)
	defer cancel(nil)
	w.mgr.register(t.ID, cancel)

	if err := w.probe(ctx, t); err != nil { w.fail(t, err); return }
	if err := w.prepareFile(t); err != nil { w.fail(t, err); return }

	g, gctx := errgroup.WithContext(ctx)
	for _, seg := range t.Segments {
		seg := seg
		g.Go(func() error { return w.downloadSegment(gctx, t, seg) })
	}

	stopAgg := w.startAggregator(ctx, t)
	err := g.Wait()
	stopAgg()

	w.finish(t, err, context.Cause(ctx))
}
```

Khi một đoạn trả lỗi không thể thử lại, `gctx` bị hủy và các đoạn khác dừng theo, vì file chỉ hoàn chỉnh khi mọi đoạn xong.

### 7.5 Đóng app gọn gàng
Wails gọi `OnBeforeClose` rồi `OnShutdown`.
1. `OnBeforeClose`: nếu còn file đang tải, tùy cài đặt: hỏi người dùng, thu xuống khay (nếu có), hoặc tiếp tục đóng.
2. `OnShutdown`: `cancel(ErrShutdown)` trên `rootCtx`; mỗi worker dừng đoạn, ghi trạng thái cuối vào SQLite (Task ở `Paused` để lần sau tự tiếp tục).
3. `wg.Wait()` với timeout 3 giây; quá hạn thì ghi log cảnh báo rồi thoát.
4. Đóng SQLite.

### 7.6 Tránh rò rỉ goroutine
- Mọi goroutine có đường thoát qua `ctx.Done()` hoặc đóng channel.
- Mọi lệnh gửi channel trong goroutine dùng `select { case ch <- v: case <-ctx.Done(): }`.
- Test dùng `goleak`.

---

## 8. Thuật toán tải

### 8.1 Probe
1. Gửi `HEAD` (theo redirect tối đa 10 lần). Nếu 405/501 hoặc thiếu `Content-Length`, gửi `GET` với `Range: bytes=0-0` và đọc `Content-Range`.
2. Lấy `TotalSize`, `AcceptRange` (`Accept-Ranges: bytes` hoặc phản hồi 206), `ETag`, `Last-Modified`.
3. Tên file: ưu tiên `Content-Disposition` (`filename*` trước `filename`), rồi phần cuối URL, rồi `download`.
4. Làm sạch tên: bỏ ký tự cấm theo hệ điều hành, chống path traversal (`..`, `/`, `\`), tối đa 200 ký tự. Nếu trùng tên thì thêm ` (1)`, ` (2)`...

### 8.2 Chọn chế độ

| Điều kiện | Chế độ |
|---|---|
| `AcceptRange` và `TotalSize >= 1 MiB` | Chia đoạn |
| `AcceptRange` nhưng file nhỏ | Một đoạn |
| Không hỗ trợ Range hoặc không biết kích thước | Một luồng, không thể tiếp tục |

Số đoạn `N = min(cấu hình, ceil(TotalSize / MinSegmentSize))`, `MinSegmentSize` mặc định 1 MiB.

### 8.3 Chia đoạn

```go
func split(total int64, n int) []*Segment {
	size := total / int64(n)
	segs := make([]*Segment, n)
	for i := 0; i < n; i++ {
		start := int64(i) * size
		end := start + size - 1
		if i == n-1 {
			end = total - 1
		}
		s := &Segment{Index: i, Start: start}
		s.End.Store(end)
		segs[i] = s
	}
	return segs
}
```

### 8.4 Tải một đoạn

```go
func (w *worker) downloadSegment(ctx context.Context, t *Task, s *Segment) error {
	buf := make([]byte, 64*1024)
	for attempt := 0; ; attempt++ {
		if s.Remaining() <= 0 { return nil }

		req, _ := http.NewRequestWithContext(ctx, "GET", t.FinalURL, nil)
		applyHeaders(req, t.Headers)
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", s.Cursor(), s.End.Load()))
		if t.ETag != "" { req.Header.Set("If-Range", t.ETag) }

		err := w.fetchInto(ctx, req, t, s, buf)
		if err == nil { return nil }
		if !retryable(err) || attempt >= w.cfg.MaxRetries { return err }
		if err := sleepBackoff(ctx, attempt); err != nil { return err }
	}
}
```

`fetchInto`:
1. Gọi `http.Client.Do`. **Phản hồi phải là 206**; nếu 200 (máy chủ bỏ qua Range) trả `ErrRangeIgnored`, không ghi dữ liệu để tránh hỏng file.
2. Kiểm tra `Content-Range` khớp `Cursor()`.
3. Vòng lặp: `limiter.WaitN(ctx, n)`, đọc vào `buf`, `file.WriteAt(buf[:n], s.Cursor())`, rồi `s.Done.Add(n)`.
4. Không đọc quá `End`: bọc body bằng `io.LimitReader(body, s.Remaining())` và kiểm tra lại `Cursor() <= End` sau mỗi lần ghi.

**Thứ tự "ghi xong mới tăng `Done`" là bất biến quan trọng:** nhờ đó `Done` lưu trong SQLite không bao giờ lớn hơn dữ liệu thật trong file.

### 8.5 Ghi file
- Tạo `<tên>.goget` và `Truncate(TotalSize)` để cấp trước dung lượng, lỗi hết đĩa lộ ra sớm.
- `os.File.WriteAt` an toàn khi nhiều goroutine gọi song song vì mỗi lần chỉ định offset riêng và các đoạn không chồng nhau.
- Khi mọi đoạn xong: `Sync()`, đóng file, `os.Rename` sang tên cuối.
- Chế độ một luồng không biết kích thước: ghi tuần tự, không `Truncate`.

### 8.6 Chia lại động (work stealing)
Khi một goroutine đoạn xong sớm, nó cắt đôi phần còn lại của đoạn còn nhiều nhất:
1. Giữ `t.segMu`.
2. Chọn `victim` có `Remaining()` lớn nhất; nếu nhỏ hơn `2*MinSegmentSize` thì bỏ qua.
3. `mid = victim.Cursor() + victim.Remaining()/2`.
4. Tạo đoạn mới `[mid, victim.End]`, đặt `victim.End.Store(mid-1)`.
5. Chạy goroutine mới cho đoạn mới trong cùng `errgroup`.

Goroutine của `victim` kiểm tra `Cursor() <= End` sau mỗi lần ghi nên dừng đúng chỗ. Làm ở v0.4; v0.2 dùng chia cố định.

### 8.6.1 Link có chữ ký hết hạn
Lưu `FinalURL` sau redirect. Nếu một đoạn nhận 403/410 giữa chừng, đánh dấu `Failed` với mã `E_LINK_EXPIRED`, giữ tiến trình, cho phép `UpdateURL` rồi tiếp tục.

### 8.7 Toàn vẹn
Sau khi xong, so kích thước file với `TotalSize`. Tùy chọn: người dùng nhập checksum, app băm bằng một goroutine riêng và báo kết quả.

---

## 9. Tạm dừng, tiếp tục, khôi phục

### 9.1 Tạm dừng
Hủy `taskCtx` (cause `ErrPaused`), các đoạn thoát giữ nguyên `Done`, ghi SQLite và `Sync()` file tạm, đặt `StatusPaused`.

### 9.2 Tiếp tục
Probe lại bằng `HEAD`, so `ETag`/`Last-Modified`/`TotalSize` với bản đã lưu:
- Khớp: tiếp tục từ `Cursor()` từng đoạn chưa xong.
- Không khớp: file đã đổi, hỏi người dùng có muốn tải lại từ đầu (không tự ghép).
- Máy chủ không còn hỗ trợ Range: báo phải tải lại từ đầu.

### 9.3 Khôi phục sau khi tắt đột ngột
- Khi mở app, Task ở `Downloading`/`Probing` được chuyển thành `Paused`.
- `Done` lưu có thể cũ hơn dữ liệu thật vài giây; an toàn vì sẽ tải lại và ghi đè đúng chỗ.
- Nếu người dùng xóa tay file `.goget`, phát hiện khi mở và đưa Task về tải lại từ đầu.

---

## 10. Thử lại và xử lý lỗi

| Loại | Ví dụ | Xử lý |
|---|---|---|
| Tạm thời | timeout, `connection reset`, EOF sớm, 5xx, 429, 408 | Thử lại với backoff |
| Máy chủ bỏ qua Range | 200 thay vì 206 | Chuyển một luồng |
| Vĩnh viễn | 404, 401, 403 ngay từ đầu | `Failed` |
| Link hết hạn | 403/410 giữa chừng | `Failed`, cho `UpdateURL` |
| Cục bộ | hết đĩa, không có quyền ghi | `Failed`, báo rõ |
| Hủy | `context.Canceled` | Không phải lỗi, xử lý theo cause |

Backoff: `chờ = min(MaxBackoff, BaseBackoff * 2^attempt) + jitter(0..25%)`, mặc định `1s / 30s / 5 lần mỗi đoạn`. Với 429 ưu tiên `Retry-After`. Nếu nhiều đoạn cùng gặp 429/503, giảm bớt số đoạn chạy cùng lúc. Một đoạn hết retry thì file `Failed` nhưng giữ tiến trình các đoạn khác để "Thử lại" chỉ tải phần thiếu.

---

## 11. Giới hạn tốc độ
- Dùng `golang.org/x/time/rate`, hai tầng: toàn cục và theo file; mỗi lần đọc `WaitN` cả hai.
- Burst bằng kích thước bộ đệm (64 KiB).
- Giới hạn `0` nghĩa là không giới hạn (`rate.Inf`).
- Đổi được khi đang tải bằng `SetLimit`, không cần khởi động lại.

---

## 12. Tiến trình, tốc độ, ETA
Mỗi 200 ms, aggregator của từng file:
1. Cộng `Done` các đoạn thành `totalDone`.
2. `inst = (totalDone - lastDone) / dt`.
3. Làm mượt: `speed = α*inst + (1-α)*speed`, `α = 0.3`.
4. `ETA = (TotalSize - totalDone) / speed` nếu `speed > 0` và biết `TotalSize`.
5. Gửi `EvProgress` cho Emitter (Emitter mới gom 250 ms rồi đẩy lên UI, xem 4.5).

Định dạng số (`1.23 GB`, `4.5 MB/s`, `2 phút 15 giây`) làm ở **frontend** (`lib/format.ts`) để hỗ trợ đa ngôn ngữ; Go chỉ gửi số thô.

---

## 13. Lưu trữ (SQLite)

- Driver `modernc.org/sqlite` (thuần Go, không CGO).
- `PRAGMA journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON;`.
- Một goroutine ghi duy nhất (hoặc `SetMaxOpenConns(1)`) để tránh "database is locked".
- File CSDL nằm trong `os.UserConfigDir()/goget/goget.db`.

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  final_url    TEXT,
  headers_json TEXT,
  file_name    TEXT NOT NULL,
  save_path    TEXT NOT NULL,
  temp_path    TEXT NOT NULL,
  total_size   INTEGER NOT NULL DEFAULT -1,
  accept_range INTEGER NOT NULL DEFAULT 0,
  etag         TEXT,
  last_mod     TEXT,
  status       INTEGER NOT NULL,
  err_code     TEXT,
  category     TEXT,
  start_at     INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS segments (
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  idx      INTEGER NOT NULL,
  start    INTEGER NOT NULL,
  "end"    INTEGER NOT NULL,
  done     INTEGER NOT NULL DEFAULT 0,
  status   INTEGER NOT NULL,
  PRIMARY KEY (task_id, idx)
);

CREATE TABLE IF NOT EXISTS history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT,
  file_name   TEXT,
  url         TEXT,
  size        INTEGER,
  finished_at INTEGER,
  avg_speed   REAL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
```

Di trú: `meta.schema_version`, chạy các bước còn thiếu theo thứ tự trong một giao dịch, sao lưu `.bak` trước khi di trú. Persist ticker ghi toàn bộ đoạn của một Task trong **một giao dịch** bằng câu lệnh đã chuẩn bị sẵn.

---

## 14. Frontend

### 14.1 Công nghệ và lý do
- **React 18 + TypeScript + Vite**: template `react-ts` của Wails, hệ sinh thái lớn, kiểu từ binding dùng trực tiếp.
- **Zustand**: store nhỏ, không boilerplate, chọn lọc state theo selector nên chỉ dòng đổi mới render lại.
- **Tailwind CSS** + biến CSS cho theme.
- **@tanstack/react-virtual**: ảo hóa danh sách khi có hàng trăm Task.
- **i18next** (hoặc bộ dịch tự viết nhỏ): tiếng Việt và tiếng Anh, tệp `locales/vi.json`, `locales/en.json`.

### 14.2 Cấu trúc

```
frontend/src/
  main.tsx  App.tsx
  store/      tasks.ts settings.ts ui.ts
  hooks/      useWailsEvents.ts useShortcuts.ts
  components/ Toolbar Sidebar TaskList TaskRow SegmentBar
              AddDialog SettingsDialog StatusBar Toast EmptyState
  lib/        api.ts format.ts i18n.ts
  locales/    vi.json en.json
  styles/     index.css theme.css
  wailsjs/    (sinh tự động)
```

### 14.3 Luồng dữ liệu một chiều
```
Go event --> useWailsEvents --> store.applyEvent() --> selector --> component
Người dùng --> component --> lib/api.ts --> wailsjs binding --> Go
```
- `lib/api.ts` bọc mọi lời gọi `wailsjs`, để dễ **mock** khi test và khi chạy giao diện trong trình duyệt thuần.
- Store giữ `Record<id, TaskDTO>` cộng một mảng `order` đã sắp xếp. `applyEvent` chỉ ghi đè theo `id`, nên ổn với event trùng hoặc lệch thứ tự (xem 4.5, 4.6).
- Phần việc nặng (lọc, sắp xếp) dùng selector có memo, không làm trong render.

### 14.4 Bố cục

```
+--------------------------------------------------------------+
| [+ Thêm URL] [▶ Tiếp tục tất cả] [⏸ Tạm dừng tất cả]   [⚙]    |
+----------+---------------------------------------------------+
| Tất cả   | Tên file            Kích thước  Tiến trình  Tốc độ |
| Đang tải |---------------------------------------------------|
| Hoàn tất | ubuntu.iso           4.6 GB   [#######---] 63%      |
| Lỗi      |   12.4 MB/s  ETA 4 phút      [⏸] [✕] [⋯]           |
|----------|   ▮▮▮▮▯▮▮▯  (8 đoạn)                              |
| Video    |---------------------------------------------------|
| Nhạc     | report.pdf           2.1 MB   [##########] Xong    |
| Tài liệu |                                                   |
| Nén      |                                                   |
+----------+---------------------------------------------------+
| Tổng: 18.2 MB/s    Đang tải: 3    Hàng đợi: 5                |
+--------------------------------------------------------------+
```

### 14.5 Thành phần chính

| Thành phần | Mô tả |
|---|---|
| `AddDialog` | Ô nhập nhiều dòng, chọn thư mục (gọi `PickDirectory`), số đoạn, hẹn giờ, nút dán từ clipboard |
| `TaskList` | Danh sách ảo hóa, hỗ trợ chọn nhiều dòng |
| `TaskRow` | Tên, kích thước, thanh tiến trình, tốc độ, ETA, nút Tạm dừng/Tiếp tục/Hủy, menu `⋯` |
| `SegmentBar` | Vẽ N ô từ mảng `segs` bằng CSS grid, tô theo phần trăm |
| `Sidebar` | Lọc theo trạng thái và danh mục |
| `StatusBar` | Tổng tốc độ, số đang tải, số hàng đợi, lấy từ `stats:update` |
| `SettingsDialog` | Thư mục, số đoạn, số file đồng thời, giới hạn tốc độ, theme, ngôn ngữ, bật/tắt clipboard |
| `Toast` | Hiển thị `app:toast` và lỗi từ Promise bị reject |

### 14.6 Trải nghiệm
- Menu chuột phải: Mở file, Mở thư mục, Sao chép URL, Tải lại, Xóa (có hoặc không xóa file).
- Phím tắt: `Ctrl/Cmd+N` thêm, `Space` tạm dừng/tiếp tục mục chọn, `Delete` xóa, `Ctrl/Cmd+,` mở cài đặt.
- Theme: biến CSS ở `:root`, ghi đè trong `[data-theme="dark"]`; mặc định theo `prefers-color-scheme`, người dùng đổi được.
- Khả năng truy cập: nút có `aria-label`, thanh tiến trình dùng `role="progressbar"` với `aria-valuenow`, điều hướng bằng bàn phím.
- Vì danh sách ảo hóa và dữ liệu cập nhật 4 lần/giây, mỗi `TaskRow` bọc `React.memo` với selector theo `id`.

### 14.7 Chạy giao diện không cần Wails
Khi `wails dev` đang chạy, mở `http://localhost:34115` bằng trình duyệt thường để dùng DevTools đầy đủ; lời gọi Go vẫn hoạt động qua WebSocket. Với test và Storybook, `lib/api.ts` được thay bằng bản giả.

---

## 15. Tính năng riêng của Wails và các giới hạn

### 15.1 Cấu hình cửa sổ (`main.go`)

```go
err := wails.Run(&options.App{
	Title:     "GoGet",
	Width:     1100, Height: 700,
	MinWidth:  800,  MinHeight: 520,
	AssetServer: &assetserver.Options{Assets: assets},
	BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 1},
	OnStartup:      app.startup,
	OnBeforeClose:  app.beforeClose,
	OnShutdown:     app.shutdown,
	Bind:           []interface{}{app},
	SingleInstanceLock: &options.SingleInstanceLock{
		UniqueId:               "com.goget.app",
		OnSecondInstanceLaunch: app.onSecondInstance,
	},
	DragAndDrop: &options.DragAndDrop{EnableFileDrop: true},
})
```

Tùy chọn cần cân nhắc: `Frameless` với thanh tiêu đề tự vẽ (đẹp nhưng phải tự lo nút thu nhỏ/phóng to/đóng và vùng kéo cửa sổ trên từng nền tảng; bắt đầu bằng thanh tiêu đề hệ thống cho đơn giản), `StartHidden` nếu chạy nền, và các tùy chọn riêng cho `Windows`, `Mac`, `Linux` (theme, hiệu ứng mờ...). Tên và trường của `options` có thể khác nhau giữa các bản v2.x, nên kiểm tra tài liệu của phiên bản đang dùng.

### 15.2 Chạy một bản duy nhất
`SingleInstanceLock` ngăn mở hai bản GoGet cùng lúc, vì hai tiến trình cùng ghi một SQLite và cùng nghe một cổng server cục bộ sẽ xung đột. Khi người dùng mở lần hai, callback đưa cửa sổ đầu lên trước và nhận tham số dòng lệnh (ví dụ một URL) để thêm Task.

### 15.3 Hộp thoại hệ thống
Chọn thư mục bằng `runtime.OpenDirectoryDialog`, chọn file danh sách link bằng `runtime.OpenFileDialog`, hỏi xác nhận bằng `runtime.MessageDialog`. Các hàm này cần `ctx` của Wails nên đặt trong `app.go`, không đặt trong lõi.

### 15.4 Kéo thả
- Kéo file `.txt` chứa link: bật `EnableFileDrop` và dùng sự kiện kéo thả của runtime để nhận đường dẫn file; Go đọc file và tách link.
- Kéo một link (văn bản) từ trình duyệt: dùng sự kiện `drop` HTML5 bình thường trong frontend, đọc `dataTransfer.getData("text/uri-list")` hoặc `"text/plain"`.
- Hành vi kéo thả khác nhau theo nền tảng; kiểm thử riêng trên từng hệ điều hành.

### 15.5 Clipboard
Có hai hướng: poll clipboard ở Go bằng `runtime.ClipboardGetText` (kiểm tra bản Wails v2 đang dùng có hàm này không), hoặc poll ở frontend. Ưu tiên ở Go để chạy được cả khi cửa sổ ẩn. Khi thấy link hợp lệ mới, phát `clipboard:url`; frontend hiện gợi ý "Tải link này?". Không bao giờ tự tải mà không hỏi.

### 15.6 Cửa sổ ẩn hoặc thu nhỏ
Khi cửa sổ không hiển thị, ngừng phát `tasks:progress` (chỉ giữ `task:status`) để tiết kiệm CPU. Theo dõi bằng `runtime.EventsOn` cho sự kiện cửa sổ hoặc cờ `visible` do `OnDomReady`/`OnBeforeClose` cập nhật; khi hiện lại, frontend gọi `ListTasks()` để đồng bộ.

### 15.7 Khay hệ thống và thông báo (hạn chế của Wails v2)
Wails v2 **không có sẵn** system tray và thông báo hệ thống (v3 có). Cách xử lý:
- **Thông báo:** dùng thư viện như `github.com/gen2brain/beeep` ở Go cho Windows/Linux/macOS; nếu không đạt thì fallback toast trong app.
- **Khay hệ thống:** dùng `github.com/energye/systray` hoặc tương tự cho Windows và Linux. Trên macOS việc chạy vòng lặp tray cùng vòng lặp của Wails có thể xung đột, nên v1.0 có thể bỏ tray trên macOS (thay bằng menu ứng dụng và Dock) hoặc chờ Wails v3. Đây là mục rủi ro đã biết, làm ở giai đoạn muộn và có thể cắt khỏi v1.0 mà không ảnh hưởng chức năng cốt lõi.
- Khi không có tray: đóng cửa sổ khi còn file đang tải thì hỏi "Tiếp tục tải trong nền hay thoát?" (nền chỉ khả thi nếu có tray; nếu không có thì chỉ thu nhỏ).

### 15.8 Khởi động cùng hệ điều hành
Tùy chọn, làm theo từng nền tảng (khóa Registry `Run` trên Windows, LaunchAgent trên macOS, `.desktop` autostart trên Linux). Đặt sau v1.0.

---

## 16. Các nguồn vào phụ

### 16.1 Scheduler
Min-heap theo `StartAt` và một `time.Timer` trỏ phần tử gần nhất; đến giờ gọi `Manager.Enqueue`. Khi khởi động nạp lại các Task có `StartAt` trong tương lai; nếu giờ đã qua thì bắt đầu ngay hoặc hỏi theo cài đặt.

### 16.2 HTTP server cục bộ cho extension (v0.5)
**Bảo mật bắt buộc:**
- Chỉ lắng nghe `127.0.0.1`.
- Mọi request cần `Authorization: Bearer <token>`; token sinh ngẫu nhiên khi cài, lưu trong thư mục cấu hình, người dùng dán vào extension một lần.
- Kiểm tra `Origin`: chỉ nhận `chrome-extension://<id>` và `moz-extension://<uuid>`, từ chối origin web thường để chặn trang lạ gửi lệnh vào app (CSRF, DNS rebinding).
- Kiểm tra `Host` là `127.0.0.1:<port>` hoặc `localhost:<port>`.
- Giới hạn kích thước body (64 KiB) và tần suất request.

| Phương thức | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/v1/ping` | Kiểm tra app đang chạy, trả phiên bản |
| POST | `/v1/tasks` | Thêm link `{url, headers, filename}` |
| GET | `/v1/tasks` | Danh sách Task |
| POST | `/v1/tasks/{id}/pause` | Tạm dừng |
| POST | `/v1/tasks/{id}/resume` | Tiếp tục |
| DELETE | `/v1/tasks/{id}` | Hủy |

Extension (Manifest V3): `chrome.downloads.onCreated` để bắt tải xuống, hủy tải gốc và chuyển link sang GoGet; thêm menu chuột phải "Tải bằng GoGet"; gửi kèm `Cookie`, `Referer`, `User-Agent` chỉ cho đúng link đó, không lưu lâu dài. Nếu GoGet không chạy, để trình duyệt tải bình thường.

---

## 17. Bảo mật

Wails mở một bề mặt mới: JS trong WebView gọi được mọi hàm exported của struct được bind. Vì vậy:

- **Giữ bề mặt bind nhỏ.** Chỉ các hàm ở mục 4.2 là exported trên `App`; hàm nội bộ viết thường. Không bind struct lớn như `Manager` trực tiếp.
- **Không tin dữ liệu từ frontend.** Frontend là mã chạy trong WebView; coi nó như đầu vào không tin cậy. Kiểm tra URL (chỉ `http`/`https`), số đoạn trong khoảng 1 đến 32, thư mục lưu hợp lệ.
- **Không có hàm nhận đường dẫn tùy ý** để đọc, ghi, xóa hay mở file. `OpenFile`, `RevealInFolder`, `Remove(deleteFile)` nhận `id` và Go tự tra đường dẫn; chỉ thao tác trên file mà Task đó tạo ra.
- **Chống path traversal** khi đặt tên: ghép bằng `filepath.Join` rồi kiểm tra kết quả vẫn nằm trong thư mục tải.
- **Chống XSS:** React tự escape; tuyệt đối không dùng `dangerouslySetInnerHTML` với tên file hay URL (đó là dữ liệu từ mạng). Đặt Content-Security-Policy chặt trong `index.html` (`default-src 'self'`, không cho script/ảnh từ nguồn ngoài).
- **Không tải nội dung từ xa vào WebView.** Giao diện chỉ dùng tài nguyên đã đóng gói trong app.
- Cookie/header từ extension chỉ giữ trong bộ nhớ và bản ghi Task tương ứng; xóa khi Task xong hoặc bị hủy; không ghi vào log.
- Xác thực TLS mặc định; chỉ cho bỏ qua chứng chỉ khi người dùng chủ động bật cho một Task, kèm cảnh báo.
- Không tự thực thi file đã tải.
- HTTP server cục bộ theo mục 16.2.

---

## 18. Cấu hình

`config.json` trong `os.UserConfigDir()/goget`.

```json
{
  "downloadDir": "~/Downloads/GoGet",
  "maxConcurrentFiles": 3,
  "segmentsPerFile": 8,
  "minSegmentSizeMiB": 1,
  "maxRetries": 5,
  "globalLimitKiBps": 0,
  "perFileLimitKiBps": 0,
  "clipboardWatch": true,
  "theme": "system",
  "language": "vi",
  "proxy": "",
  "userAgent": "",
  "closeAction": "ask",
  "server": { "enabled": false, "port": 18080 },
  "categories": {
    "video": [".mp4", ".mkv", ".avi", ".mov", ".webm"],
    "music": [".mp3", ".flac", ".wav", ".m4a"],
    "doc": [".pdf", ".docx", ".xlsx", ".pptx", ".txt"],
    "archive": [".zip", ".rar", ".7z", ".tar", ".gz"]
  }
}
```

Kiểm tra khi nạp: `segmentsPerFile` 1 đến 32, `maxConcurrentFiles` 1 đến 10, sai thì dùng mặc định và ghi log. Thay đổi giới hạn tốc độ và theme áp dụng ngay; số đoạn áp dụng cho Task mới. Hỗ trợ proxy HTTP/SOCKS5 qua `http.Transport.Proxy`. Cài đặt do frontend sửa đi qua `SaveSettings`, Go kiểm tra lại rồi mới lưu.

---

## 19. Lớp HTTP
- Một `http.Client` dùng chung với `http.Transport` tinh chỉnh: `MaxIdleConnsPerHost` bằng ít nhất số đoạn mỗi file; `ResponseHeaderTimeout` 30 s; `TLSHandshakeTimeout` và dial timeout 15 s.
- **Không** đặt `Client.Timeout` tổng vì sẽ cắt các lần tải dài. Dùng idle timeout: 30 s không đọc được byte nào thì coi là treo và thử lại.
- `DisableCompression: true` để `Content-Length` và `Range` khớp byte thật.
- `User-Agent` mặc định `GoGet/<phiên bản>`, cho phép đổi.

---

## 20. Ghi log và chẩn đoán
- `log/slog`, ghi ra file xoay vòng trong thư mục cấu hình (10 MB x 3 file).
- Mức `INFO` mặc định, `DEBUG` khi bật trong Cài đặt; mỗi bản ghi có `task_id`.
- Không ghi cookie, token, header nhạy cảm.
- Nút "Sao chép thông tin chẩn đoán" (phiên bản, hệ điều hành, phiên bản WebView, cấu hình đã ẩn dữ liệu nhạy cảm).
- Có thể gửi log từ Go lên giao diện qua `runtime.LogInfo` hoặc event riêng khi ở chế độ debug.

---

## 21. Kiểm thử

### 21.1 Go (lõi)
- **Đơn vị:** `split` (kích thước nhỏ hơn số đoạn, chia hết, có dư, một đoạn; phủ kín `[0,total-1]` không chồng); parser `Content-Disposition`; làm sạch tên file và chống path traversal; backoff; tính tốc độ/ETA; phân loại lỗi `retryable`.
- **Tích hợp bằng `httptest`:** máy chủ giả có thể điều khiển: hỗ trợ Range đầy đủ (`http.ServeContent`), không hỗ trợ Range, trả 200 cho request có Range, chậm, cắt kết nối ngẫu nhiên, trả 503/429 vài lần, đổi ETag giữa các lần.
- **Bất biến quan trọng nhất:** SHA-256 file tải về bằng SHA-256 dữ liệu gốc trong mọi kịch bản, kể cả tạm dừng/tiếp tục nhiều lần và tắt app giả lập.
- **Đồng thời:** `go test -race`, `goleak.VerifyNone`, test căng 50 Task x 16 đoạn, fuzz parser header và tên file.

### 21.2 Lớp `app.go` và Emitter
- Test Emitter độc lập (không cần Wails): đưa nhiều `ProgressItem`, kiểm tra gom đúng, cái mới đè cái cũ, không phát khi rỗng. Truyền một hàm `emit func(name string, data any)` thay vì gọi `runtime.EventsEmit` trực tiếp để test được.
- Test các hàm bind bằng cách gọi trực tiếp (chúng chỉ là hàm Go) với `Manager` giả.

### 21.3 Frontend
- **Vitest + Testing Library** cho store (`applyEvent` với event trùng/lệch thứ tự), `format.ts`, và các component chính.
- `lib/api.ts` được mock; không cần Wails khi chạy test.
- E2E: chạy `wails dev` rồi dùng Playwright trỏ vào `http://localhost:34115` (bindings vẫn hoạt động qua WebSocket) cho các luồng chính: thêm link, tải, tạm dừng, tiếp tục. Phần này tùy chọn, làm sau.
- Kiểm thử thủ công trên 3 hệ điều hành trước mỗi bản phát hành, đặc biệt kéo thả, clipboard, hộp thoại và hiển thị WebView.

### 21.4 CI
GitHub Actions ma trận Windows/macOS/Linux: `gofmt -l`, `go vet`, `staticcheck`, `go test -race ./...`, `npm ci && npm run lint && npm test`, rồi `wails build` thử. Trên Linux cài `libgtk-3-dev` và `libwebkit2gtk-4.x-dev` tương ứng.

---

## 22. Đóng gói và phát hành

| Nền tảng | Lệnh | Ghi chú |
|---|---|---|
| Windows | `wails build -platform windows/amd64 -nsis` | NSIS tạo trình cài đặt và kèm WebView2 bootstrapper cho Windows 10 |
| macOS | `wails build -platform darwin/universal` | Một bản chạy cả Intel và Apple Silicon; cần ký số và notarize để tránh cảnh báo Gatekeeper |
| Linux | `wails build -tags webkit2_41` | Ubuntu 24.04 trở lên dùng webkit2gtk 4.1 (cần build tag); bản cũ dùng 4.0. Phân phối `.deb` hoặc AppImage bằng công cụ ngoài |

Vấn đề cần chuẩn bị sớm:
- **Ký số:** chứng chỉ Windows (tránh SmartScreen), Apple Developer ID (ký và notarize). Đây là chi phí và thời gian đáng kể, nên lên kế hoạch từ trước v1.0.
- **Phiên bản webkit2gtk trên Linux** khác nhau theo bản phân phối; ghi rõ trong tài liệu cài đặt.
- **Biểu tượng và metadata:** `build/appicon.png`, `build/windows/info.json`, `build/darwin/Info.plist`.
- **Tự cập nhật:** Wails v2 không có sẵn; làm đơn giản bằng việc kiểm tra bản mới qua GitHub Releases và mở trang tải, sau v1.0.

---

## 23. Hiệu năng và chỉ tiêu

| Chỉ tiêu | Mục tiêu |
|---|---|
| Khởi động tới khi hiện UI | dưới 1,5 giây |
| RAM khi tải 10 file x 8 đoạn (gồm WebView) | dưới 250 MB |
| CPU lõi tải ở 100 MB/s | dưới 15% một nhân |
| Tần suất đẩy tiến trình lên UI | tối đa 4 lần/giây (gộp mọi Task) |
| UI khi có 500 Task | cuộn mượt nhờ ảo hóa, không giật khi nhận event |
| Hủy / tạm dừng | phản hồi dưới 1 giây |

Ghi chú: bộ đệm 64 KiB mỗi đoạn cân bằng giữa số syscall và RAM; 8 đoạn là hợp lý vì nhiều hơn không giúp khi nghẽn ở đường truyền hay ổ đĩa; trên HDD ghi ngẫu nhiều đoạn có thể chậm, đo trước khi tối ưu.

---

## 24. Lộ trình triển khai chi tiết

### v0.1 Nền tảng
- [ ] `wails init -t react-ts`, dọn template, cấu trúc thư mục theo mục 3.3
- [ ] `Manager`, `jobs`, worker pool, `events` (lõi chưa phụ thuộc Wails)
- [ ] Tải một luồng cơ bản, hủy bằng `context`
- [ ] `app.go`: `AddURLs`, `ListTasks`, `Cancel`
- [ ] Emitter và event `task:*`, `tasks:progress`
- [ ] Frontend: store, `useWailsEvents`, `TaskList`, `TaskRow`, `AddDialog` tối giản

### v0.2 Tải chia đoạn
- [ ] `probe.go`: HEAD, fallback `Range: bytes=0-0`, tên file
- [ ] `segment.go`: chia đoạn, `downloadSegment`, `WriteAt`, cấp trước file `.goget`, đổi tên khi xong
- [ ] Progress aggregator, tốc độ làm mượt, ETA
- [ ] `SegmentBar`, `GetTaskDetail`
- [ ] Test `httptest` + SHA-256

### v0.3 Tạm dừng và khôi phục
- [ ] Lược đồ SQLite, di trú, persist ticker
- [ ] `Pause`, `Resume`, kiểm tra ETag
- [ ] Khôi phục sau khi tắt đột ngột
- [ ] `retry.go`: backoff, phân loại lỗi, `Retry-After`
- [ ] Test cắt kết nối, tắt app giả lập

### v0.4 Tiện ích
- [ ] Clipboard watcher, kéo thả
- [ ] Scheduler hẹn giờ
- [ ] Limiter toàn cục và theo file
- [ ] Work stealing
- [ ] Danh mục, lịch sử
- [ ] Cài đặt, theme sáng/tối, i18n vi/en
- [ ] `SingleInstanceLock`, thông báo (beeep)

### v0.5 Tích hợp trình duyệt
- [ ] HTTP server cục bộ có token, kiểm tra Origin/Host
- [ ] Extension Chrome (MV3), rồi Firefox
- [ ] Gửi cookie/header theo từng link

### v1.0 Phát hành
- [ ] Đóng gói và ký số cho Windows, macOS, Linux
- [ ] Khay hệ thống (nếu đạt trên các nền tảng, nếu không thì cắt)
- [ ] Trình cài đặt NSIS, DMG, `.deb`/AppImage
- [ ] Tài liệu người dùng, trang phát hành, kiểm thử hồi quy toàn bộ

---

## 25. Rủi ro và cách giảm thiểu

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Máy chủ giới hạn kết nối hoặc chặn IP khi dùng nhiều đoạn | Trung bình | Mặc định 8 đoạn, giảm khi gặp 429/503, trần cứng 32 |
| Máy chủ bỏ qua Range gây hỏng file | Cao | Bắt buộc 206 và `Content-Range`, không ghi nếu sai |
| Link có chữ ký hết hạn giữa chừng | Trung bình | Giữ tiến trình, `UpdateURL` rồi tiếp tục |
| Data race giữa goroutine tải, tổng hợp, Emitter | Cao | `atomic`, `-race` trong CI, ít chỗ dùng chung |
| Rò rỉ goroutine khi hủy | Trung bình | Mọi goroutine thoát qua `ctx`, `goleak` |
| Cầu nối Go ↔ WebView nghẽn khi nhiều Task | Trung bình | Gom 250 ms, payload nhỏ, trạng thái tuyệt đối, ẩn thì ngừng đẩy |
| Hành vi WebView khác nhau giữa 3 hệ điều hành | Trung bình | CI ma trận, kiểm thử thủ công từng nền tảng, tránh CSS/JS quá mới |
| webkit2gtk 4.0 vs 4.1 trên Linux | Trung bình | Build tag `webkit2_41`, ghi rõ yêu cầu |
| Thiếu tray và thông báo trong Wails v2, tray có thể lỗi trên macOS | Trung bình | Thư viện ngoài, fallback toast, có thể cắt khỏi v1.0 hoặc chờ Wails v3 |
| JS gọi hàm Go ngoài ý muốn (bề mặt bind) | Cao | Bề mặt bind nhỏ, không nhận đường dẫn tùy ý, kiểm tra mọi đầu vào |
| XSS qua tên file/URL độc hại | Cao | React escape, CSP chặt, không dùng `dangerouslySetInnerHTML` |
| Extension bị lợi dụng gửi lệnh vào app | Cao | Token, kiểm tra Origin/Host, chỉ `127.0.0.1` |
| Chi phí ký số và notarize | Thấp (kỹ thuật) / cao (thời gian) | Lên kế hoạch sớm, có thể phát hành bản chưa ký cho người dùng kỹ thuật |
| Đĩa đầy giữa chừng | Thấp | Cấp trước dung lượng bằng `Truncate`, báo lỗi rõ |
| Hỏng cơ sở dữ liệu SQLite | Thấp | WAL, giao dịch, sao lưu `.bak` khi di trú |

---

## 26. API nội bộ của Manager

```go
type Manager interface {
	Add(ctx context.Context, req AddRequest) (TaskID, error)
	Pause(id TaskID) error
	Resume(id TaskID) error
	Cancel(id TaskID, deleteFile bool) error
	Retry(id TaskID) error
	UpdateURL(id TaskID, newURL string) error
	Remove(id TaskID, deleteFile bool) error

	Snapshot() []TaskSnapshot
	Get(id TaskID) (TaskSnapshot, bool)
	Events() <-chan Event

	SetLimits(global, perFile int64) // byte/giây, 0 = không giới hạn
	SetMaxConcurrent(n int)

	Shutdown(ctx context.Context) error
}

type AddRequest struct {
	URL      string
	SaveDir  string
	FileName string
	Headers  map[string]string
	Segments int        // 0 = theo cấu hình
	StartAt  *time.Time
}
```

`TaskSnapshot` là bản sao bất biến tại một thời điểm; `app.go` đổi nó thành `dto.TaskDTO`.

---

## 27. Thuật ngữ

| Thuật ngữ | Nghĩa |
|---|---|
| Binding | Hàm Go được Wails sinh mã JS/TS để frontend gọi như hàm thường |
| Event (Wails) | Thông điệp một chiều Go → frontend (hoặc ngược lại) qua `EventsEmit`/`EventsOn` |
| Đoạn (segment) | Một khoảng byte liên tục của file, tải bởi một goroutine |
| Range request | Yêu cầu HTTP chỉ lấy một phần nội dung (`Range: bytes=a-b`) |
| Probe | Bước thăm dò kích thước và khả năng hỗ trợ Range |
| Worker pool | Nhóm goroutine cố định nhận việc từ một channel |
| Work stealing | Goroutine rảnh lấy bớt việc của goroutine còn nhiều việc |
| Backoff | Chờ lâu dần giữa các lần thử lại |
| ETag | Mã định danh phiên bản nội dung do máy chủ cấp |
