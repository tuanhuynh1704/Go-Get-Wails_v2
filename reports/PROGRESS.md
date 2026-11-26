# Tiến độ GoGet Wails

Cập nhật: 26/11/2026. Nguồn phạm vi: `README.md` và `DESIGN.md`.

| Giai đoạn | Trạng thái | Bằng chứng / báo cáo |
|---|---|---|
| 00: Khảo sát, thiết kế và kế hoạch | Đã commit và push `master` tại `9adaddc` | [00-discovery.md](00-discovery.md) |
| v0.1: Nền tảng Wails + React | Hoàn thành; CI Windows/macOS/Linux và Go 1.22.12 đạt tại `01832d6`, đã merge và push `master` | [01-v0.1.md](01-v0.1.md) |
| v0.2: Chia đoạn, tốc độ và ETA | Hoàn thành; kiểm chứng Windows và CI Windows/macOS/Linux, Go 1.22.12 đạt tại `33f2985`, đã tích hợp `master` | [02-v0.2.md](02-v0.2.md) |
| v0.3: Tạm dừng, lưu trạng thái, retry | Chưa triển khai | SQLite, validator, khôi phục và kiểm thử mất kết nối |
| v0.4: Tiện ích | Chưa triển khai | Clipboard, scheduler, limiter, danh mục, cài đặt, theme, i18n |
| v0.5: Extension | Chưa triển khai | Loopback API, token, Origin/Host và extension |
| v1.0: Phát hành | Chưa triển khai | Kiểm chứng ba hệ điều hành, installer và ký số |

Các mốc tính năng chỉ được commit và push sau khi có kiểm chứng. Mã v0.1 được tích hợp trên `feat/wails-v0.1`, sau đó merge vào `master`. Bản sửa oracle đường dẫn `01832d6` trên `fix/ci-canonical-directory` đã qua đủ bốn job trong [CI run 45812919698](https://github.com/tuanhuynh1704/Go-Get-Wails_v2/actions/runs/45812919698), sau đó merge fast-forward và push lên `master`. CI đã tạo ba artifact `GoGet-Windows`, `GoGet-macOS`, `GoGet-Linux`. Kiểm thử/build trên runner không thay thế việc kiểm tra giao diện desktop, installer và ký số của v1.0. Chứng chỉ ký số vẫn là phụ thuộc bên ngoài của v1.0.

Mã v0.2 tại `33f2985` trên `feat/wails-v0.2` đã qua đủ bốn job trong [CI run 45830725940](https://github.com/tuanhuynh1704/Go-Get-Wails_v2/actions/runs/45830725940), với đủ ba artifact còn hiệu lực. `master` được fast-forward từ `9409716` tới commit này; commit chốt báo cáo chỉ thay đổi tài liệu. Bằng chứng E2E backend Wails thật tại Windows và giới hạn tự động hóa desktop được ghi riêng trong báo cáo v0.2.
