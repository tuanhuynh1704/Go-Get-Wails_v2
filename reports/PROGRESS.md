# Tiến độ GoGet Wails

Cập nhật: 26/11/2026. Nguồn phạm vi: `README.md` và `DESIGN.md`.

| Giai đoạn | Trạng thái | Bằng chứng / báo cáo |
|---|---|---|
| 00: Khảo sát, thiết kế và kế hoạch | Đã commit và push `master` tại `9adaddc` | [00-discovery.md](00-discovery.md) |
| v0.1: Nền tảng Wails + React | Hoàn thành và kiểm chứng Windows; CI đa nền tảng sẽ được ghi riêng sau push | [01-v0.1.md](01-v0.1.md) |
| v0.2: Chia đoạn, tốc độ và ETA | Chưa triển khai | HEAD/Range, WriteAt, fallback, SegmentBar, checksum |
| v0.3: Tạm dừng, lưu trạng thái, retry | Chưa triển khai | SQLite, validator, khôi phục và kiểm thử mất kết nối |
| v0.4: Tiện ích | Chưa triển khai | Clipboard, scheduler, limiter, danh mục, cài đặt, theme, i18n |
| v0.5: Extension | Chưa triển khai | Loopback API, token, Origin/Host và extension |
| v1.0: Phát hành | Chưa triển khai | Kiểm chứng ba hệ điều hành, installer và ký số |

Các mốc tính năng chỉ được commit và push sau khi có kiểm chứng. Mã v0.1 được tích hợp trên `feat/wails-v0.1`, sau đó merge vào `master`. Kết quả Windows tại máy không thay thế kết quả CI hoặc kiểm thử native Linux/macOS. Chứng chỉ ký số vẫn là phụ thuộc bên ngoài của v1.0.
