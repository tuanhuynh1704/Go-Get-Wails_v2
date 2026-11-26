# GoGet - IDM mini viết bằng Go + Wails

Trình quản lý tải file desktop đa nền tảng. Phần lõi tải viết bằng **Go**, giao diện viết bằng **web (React + TypeScript)** và ghép lại bằng **Wails v2**. Ý tưởng giống IDM: **chia mỗi file thành nhiều đoạn và tải song song bằng goroutine**, nhờ đó file lớn tải nhanh hơn, tạm dừng được và tiếp tục được, kể cả sau khi tắt app.

Dự án đồng thời là bài thực hành các mẫu đồng thời của Go (worker pool, channel, context, atomic) và cách nối một backend Go với giao diện web hiện đại qua Wails.

> Trạng thái: **đang ở giai đoạn thiết kế**, chưa có code. Chi tiết kỹ thuật nằm trong [DESIGN.md](DESIGN.md).

## Vì sao chọn Wails v2

- Giao diện làm bằng HTML/CSS/JS nên đẹp và linh hoạt hơn nhiều so với widget thuần Go; dễ làm danh sách ảo hóa, biểu đồ tốc độ, theme sáng/tối.
- Backend Go gọi từ frontend như hàm bình thường (Wails tự sinh binding TypeScript), và Go đẩy sự kiện lên giao diện bằng event.
- Không đóng gói kèm trình duyệt như Electron: dùng WebView có sẵn của hệ điều hành nên file nhỏ và nhẹ RAM hơn.
- Không cần CGO cho phần lõi; SQLite dùng bản thuần Go.

## Tính năng

**v0.1: Nền tảng**
- Dự án Wails chạy được, frontend React kết nối backend Go
- Thêm nhiều URL (mỗi dòng một link), tải đồng thời nhiều file bằng worker pool
- Thanh tiến trình từng file cập nhật qua event
- Hủy từng file hoặc tất cả

**v0.2: Tải chia đoạn (tính năng chính)**
- Gửi `HEAD` lấy `Content-Length`, kiểm tra `Accept-Ranges: bytes`
- Chia file thành N đoạn (mặc định 8), mỗi đoạn một goroutine tải bằng header `Range`
- Ghi thẳng vào đúng vị trí trong file bằng `WriteAt`, không cần gộp file sau
- Quay về tải một luồng nếu máy chủ không hỗ trợ `Range`
- Hiển thị tốc độ, ETA và tiến trình từng đoạn

**v0.3: Tạm dừng và khôi phục**
- Tạm dừng / tiếp tục từng file
- Lưu trạng thái từng đoạn vào SQLite, tắt app mở lại vẫn tải tiếp đúng chỗ
- Tự thử lại đoạn lỗi với exponential backoff
- Kiểm tra ETag / Last-Modified trước khi tiếp tục

**v0.4: Tiện ích kiểu IDM**
- Tự bắt URL khi bạn copy vào clipboard
- Hẹn giờ bắt đầu tải
- Giới hạn tốc độ tổng và theo từng file
- Phân loại tự động theo đuôi file, lịch sử tải
- Kéo thả link hoặc file `.txt` danh sách link vào cửa sổ
- Cài đặt, theme sáng/tối, tiếng Việt và tiếng Anh

**v0.5: Tích hợp trình duyệt**
- HTTP server cục bộ (`127.0.0.1`, có token) nhận link từ extension Chrome/Firefox
- Extension gửi kèm cookie/header để tải link cần đăng nhập

## Công nghệ

| Thành phần | Lựa chọn |
|---|---|
| Khung ứng dụng | Wails v2 |
| Backend | Go 1.22+ |
| Frontend | React 18 + TypeScript + Vite |
| Quản lý state UI | Zustand |
| Style | Tailwind CSS (theme bằng CSS variables) |
| Danh sách dài | `@tanstack/react-virtual` |
| Mạng | `net/http` chuẩn |
| Giới hạn tốc độ | `golang.org/x/time/rate` |
| Lưu trữ | SQLite (`modernc.org/sqlite`, không cần CGO) |
| Test Go / test frontend | `testing` + `httptest` + `goleak` / Vitest + Testing Library |

## Kiến trúc tổng quan

```
+--------------------- WebView (React + TS) ---------------------+
|  Components  <--  Zustand store  <--  wailsjs bindings/events   |
+--------------------------+--------------------------------------+
                           | gọi hàm (Promise)      ^ EventsEmit
                           v                        |
+--------------------------+------------------------+-------------+
|  app.go: lớp mỏng, chuyển lệnh sang Manager, gom và đẩy event    |
+--------------------------+--------------------------------------+
                           v
+--------------------------+--------------------------------------+
|  Manager (điều phối) --> worker pool --> N goroutine đoạn        |
|        |                                                         |
|        +--> SQLite (trạng thái đoạn)   +--> limiter, retry       |
+-------------------------------------------------------------------+
   Nguồn vào phụ: clipboard watcher, scheduler, local HTTP server
```

Hai nguyên tắc quan trọng:
- Lõi `internal/downloader` **không import Wails**. Nó chỉ phát `Event` qua channel. Nhờ vậy test được bằng `httptest` và tái dùng cho bản CLI.
- Tiến trình được **gom lại rồi mới đẩy** lên giao diện (tối đa 4 lần/giây), không đẩy từng gói dữ liệu, để cầu nối Go ↔ WebView không bị nghẽn.

## Cấu trúc thư mục

```
goget/
├── main.go                    # wails.Run, cấu hình cửa sổ
├── app.go                     # struct App: các hàm được bind cho frontend
├── wails.json
├── go.mod
├── README.md
├── DESIGN.md
├── build/                     # icon, cấu hình installer (NSIS, Info.plist)
├── internal/
│   ├── downloader/            # manager, worker, segment, probe, retry, limiter, progress
│   ├── storage/               # SQLite, lược đồ, di trú
│   ├── watcher/               # clipboard, scheduler
│   ├── server/                # HTTP server cục bộ cho extension
│   ├── config/                # đọc/ghi cấu hình
│   ├── dto/                   # kiểu dữ liệu trao đổi với frontend
│   └── util/                  # tên file, định dạng
├── frontend/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── store/             # Zustand: tasks, settings, ui
│   │   ├── components/        # TaskList, TaskRow, SegmentBar, AddDialog, Settings...
│   │   ├── hooks/             # useWailsEvents, useShortcuts
│   │   ├── lib/               # format, api (bọc wailsjs), i18n
│   │   └── styles/
│   └── wailsjs/               # SINH TỰ ĐỘNG, không sửa tay
└── extension/                 # extension trình duyệt (v0.5)
```

## Cài đặt và chạy

**Yêu cầu**
- Go 1.22 trở lên
- Node.js 18 trở lên
- Wails CLI:
  ```bash
  go install github.com/wailsapp/wails/v2/cmd/wails@latest
  wails doctor      # kiểm tra môi trường còn thiếu gì
  ```
- Theo nền tảng:
  - **Windows:** WebView2 Runtime (Windows 11 có sẵn; Windows 10 sẽ được installer cài kèm)
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Linux:** `gcc`, `libgtk-3-dev`, `libwebkit2gtk-4.0-dev` (hoặc `4.1` trên Ubuntu 24.04, xem mục Đóng gói)

**Khởi tạo và chạy chế độ phát triển**
```bash
wails init -n goget -t react-ts
cd goget
wails dev          # hot reload cho cả Go lẫn frontend
```
Trong `wails dev`, frontend cũng truy cập được tại `http://localhost:34115` bằng trình duyệt thường (tiện cho DevTools và kiểm thử giao diện).

**Đóng gói**
```bash
wails build                              # nền tảng hiện tại
wails build -platform windows/amd64 -nsis   # kèm trình cài đặt NSIS
wails build -platform darwin/universal   # macOS Intel + Apple Silicon
wails build -tags webkit2_41             # Linux dùng webkit2gtk 4.1 (Ubuntu 24.04+)
```

## Cách sử dụng

1. Mở app, bấm **Thêm URL** và dán các link (mỗi dòng một link), hoặc chỉ cần copy link để app gợi ý tải
2. Chọn thư mục lưu và số đoạn nếu muốn, bấm **Tải**
3. Theo dõi tiến trình, tốc độ, ETA; dùng **Tạm dừng / Tiếp tục / Hủy** khi cần
4. File hoàn tất nằm trong thư mục đã chọn; bấm "Mở thư mục" để tới nơi lưu

## Lộ trình phát triển

- [ ] v0.1: khung Wails + React, worker pool, tiến trình qua event, hủy tác vụ
- [ ] v0.2: tải chia đoạn, tốc độ và ETA, hiển thị từng đoạn
- [ ] v0.3: tạm dừng/tiếp tục, lưu trạng thái SQLite, retry
- [ ] v0.4: clipboard, hẹn giờ, giới hạn tốc độ, kéo thả, cài đặt, theme, i18n
- [ ] v0.5: HTTP server cục bộ và extension trình duyệt
- [ ] v1.0: đóng gói và ký số cho Windows, macOS, Linux

## Kiểm thử

```bash
go test ./...
go test -race ./...           # bắt buộc trước khi merge
cd frontend && npm test       # Vitest + Testing Library
```

Gợi ý: dùng `httptest.NewServer` giả lập máy chủ có và không hỗ trợ `Range`, kiểm tra SHA-256 file tải về khớp bản gốc trong mọi kịch bản (hủy giữa chừng, tạm dừng, tắt app giả lập).

## Lưu ý

- Wails v2 không có sẵn khay hệ thống (system tray) và thông báo hệ thống. Dự án dùng thư viện bên thứ ba cho các phần này và có thể bị hạn chế trên macOS; chi tiết trong DESIGN.md.
- Chỉ dùng để tải nội dung bạn có quyền tải. Tôn trọng điều khoản của máy chủ và đừng đặt số đoạn quá cao gây tải nặng.
- HTTP server cục bộ chỉ lắng nghe `127.0.0.1` và yêu cầu token.

## Đóng góp

1. Fork repo và tạo nhánh mới
2. Chạy `gofmt`, `go vet ./...` và `npm run lint`
3. Đảm bảo `go test -race ./...` và `npm test` pass
4. Mở Pull Request kèm mô tả thay đổi

## Giấy phép

MIT License
