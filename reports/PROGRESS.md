# Tiến độ GoGet Wails

Cập nhật: 26/11/2026. Nguồn phạm vi: `README.md` và `DESIGN.md`.

| Giai đoạn | Trạng thái | Bằng chứng / báo cáo |
|---|---|---|
| 00: Khảo sát, thiết kế và kế hoạch | Đã commit và push `master` tại `9adaddc` | [00-discovery.md](00-discovery.md) |
| v0.1: Nền tảng Wails + React | Hoàn thành; CI Windows/macOS/Linux và Go 1.22.12 đạt tại `01832d6`, đã merge và push `master` | [01-v0.1.md](01-v0.1.md) |
| v0.2: Chia đoạn, tốc độ và ETA | Hoàn thành; kiểm chứng Windows và CI Windows/macOS/Linux, Go 1.22.12 đạt tại `33f2985`, đã tích hợp `master` | [02-v0.2.md](02-v0.2.md) |
| v0.3: Tạm dừng, lưu trạng thái, retry | Chưa triển khai | SQLite, validator, khôi phục và kiểm thử mất kết nối |
| v0.4: Tiện ích | Phân loại file đã kiểm chứng tại Windows và CI đa nền tảng tại `86963a8`, đã tích hợp `master`; các tiện ích còn lại chưa triển khai | Phân loại theo tên file HTTP, bộ lọc và số lượng; clipboard, scheduler, limiter, lịch sử, cài đặt, theme, i18n còn trong lộ trình |
| v0.5: Extension | Chưa triển khai | Loopback API, token, Origin/Host và extension |
| v1.0: Phát hành | Chưa triển khai | Kiểm chứng ba hệ điều hành, installer và ký số |

Các mốc tính năng chỉ được commit và push sau khi có kiểm chứng. Mã v0.1 được tích hợp trên `feat/wails-v0.1`, sau đó merge vào `master`. Bản sửa oracle đường dẫn `01832d6` trên `fix/ci-canonical-directory` đã qua đủ bốn job trong [CI run 45812919698](https://github.com/tuanhuynh1704/Go-Get-Wails_v2/actions/runs/45812919698), sau đó merge fast-forward và push lên `master`. CI đã tạo ba artifact `GoGet-Windows`, `GoGet-macOS`, `GoGet-Linux`. Kiểm thử/build trên runner không thay thế việc kiểm tra giao diện desktop, installer và ký số của v1.0. Chứng chỉ ký số vẫn là phụ thuộc bên ngoài của v1.0.

Mã v0.2 tại `33f2985` trên `feat/wails-v0.2` đã qua đủ bốn job trong [CI run 45830725940](https://github.com/tuanhuynh1704/Go-Get-Wails_v2/actions/runs/45830725940), với đủ ba artifact còn hiệu lực. `master` được fast-forward từ `9409716` tới commit này; commit chốt báo cáo chỉ thay đổi tài liệu. Bằng chứng E2E backend Wails thật tại Windows và giới hạn tự động hóa desktop được ghi riêng trong báo cáo v0.2.

Phần bổ sung phân loại dùng đuôi của tên file đã được chọn để lưu, gồm `video`, `music`, `doc`, `archive`, `other`; danh mục và số lượng cập nhật khi HTTP sửa tên đoán từ URL. Không di chuyển file sang thư mục con hoặc bổ sung lưu lịch sử. Kiểm chứng tại Windows: Go toàn bộ/race, Go 1.22.12, vet và staticcheck đạt; frontend đạt 111 kiểm thử. E2E backend Wails thật tải đủ năm nhóm từ URL `.bin` với tên HTTP khác nhau, xác nhận SHA-256, snapshot/detail và bộ lọc UI, giữ nguyên các kiểm tra chia đoạn/hủy/cleanup; không có pageerror. Ảnh tại `frontend/coverage/wails/category-*.png` được ignore.

Browser smoke với bridge mô phỏng đạt ở 360/390/768/1280 px: lọc và số lượng đúng, xử lý sửa danh mục cùng trạng thái, không overflow ngang/pageerror/lỗi contrast được phát hiện; danh sách 100 tác vụ mỗi danh mục chỉ mount 7-8 dòng. Đã xem ảnh mobile/desktop và trạng thái rỗng. Thăm dò thêm cửa sổ cao 640 px ghi nhận hình minh họa trạng thái rỗng có thể chồng phần đầu danh sách (bố cục chung có sẵn); chưa xử lý trong phạm vi phân loại. `wails build -m -nosyncgomod -nocolour` đạt production Windows/amd64, tạo `build/bin/GoGet.exe` trong 11,036 giây. Các server kiểm thử đã dừng.

Commit phân loại `86963a8152fff2d047932487069ddc54e49c252a` trên `feat/file-categories` đã qua đủ bốn job trong [CI run 45841367223](https://github.com/tuanhuynh1704/Go-Get-Wails_v2/actions/runs/45841367223): Windows, macOS, Ubuntu 22.04 và Go tối thiểu 1.22.12. API artifact xác nhận ba bản chưa hết hạn: `GoGet-Windows` (ID `15128956122`), `GoGet-macOS` (ID `15129130431`), `GoGet-Linux` (ID `15129535431`). `master` được fast-forward từ `375d816` tới commit này sau khi xác nhận CI. Commit chốt sau đó chỉ cập nhật README, DESIGN và báo cáo tiến độ; mã ứng dụng giữ nguyên bản đã kiểm chứng.
