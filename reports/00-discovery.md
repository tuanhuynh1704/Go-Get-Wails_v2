# Giai đoạn 00: Khảo sát và xác lập lộ trình

- Ngày: 26/11/2026.
- Trạng thái: hoàn thành khảo sát; chưa xác nhận hoàn thành chức năng sản phẩm.
- Nguồn yêu cầu: `README.md` và toàn bộ `DESIGN.md` (27 mục).
- Yêu cầu bàn giao: mỗi giai đoạn có báo cáo kết quả, commit chi tiết và push GitHub; có thể dùng nhánh sửa lỗi rồi merge vào `master` nếu cần.

## Hiện trạng ban đầu

Repository chỉ có hai tài liệu chưa được theo dõi: `README.md`, `DESIGN.md`. Nhánh hiện tại là `master`, chưa có commit. Remote `origin` là `https://github.com/tuanhuynh1704/Go-Get-Wails_v2.git`; `git ls-remote origin` thành công và chưa trả về ref nào. Không có mã nguồn hay bộ kiểm thử để chạy ở thời điểm khảo sát.

## Phạm vi và thứ tự triển khai

| Mốc | Kết quả cần đạt | Điều kiện xác nhận |
|---|---|---|
| v0.1 | Wails v2 + React/TypeScript; thêm nhiều URL; worker pool; tiến trình; hủy từng tác vụ và tất cả | Tải đúng byte bằng máy chủ thử nghiệm; kiểm tra hủy/đóng app; Go tests/race/vet; frontend tests/typecheck; build desktop |
| v0.2 | Probe HEAD/Range; chia đoạn; WriteAt; fallback một luồng; tốc độ/ETA; chi tiết đoạn | SHA-256 khớp với máy chủ hỗ trợ/không hỗ trợ/bỏ qua Range; không ghi chồng đoạn |
| v0.3 | SQLite; pause/resume; khôi phục; kiểm tra validator; retry/backoff | Kiểm thử ngắt kết nối, đổi ETag, khởi động lại và tính toàn vẹn file |
| v0.4 | Clipboard; hẹn giờ; limiter; tiện ích danh mục/lịch sử; cài đặt/theme/i18n; tối ưu đoạn | Kiểm thử riêng nguồn vào, giới hạn tốc độ và dữ liệu cấu hình; kiểm tra UI tương ứng |
| v0.5 | HTTP loopback có token và extension trình duyệt | Kiểm tra xác thực, Origin/Host, giới hạn request, luồng gửi link và fallback trình duyệt |
| v1.0 | Đóng gói và phát hành đa nền tảng | Build/kiểm thử Windows, macOS, Linux; tài liệu sử dụng; chứng chỉ ký số do chủ dự án cung cấp |

Đợt triển khai đầu tập trung vào v0.1. Các mục thuộc mốc sau được giữ trong lộ trình, không được đánh dấu hoàn thành khi chỉ có khung hoặc dữ liệu giả. Người thực hiện chính chịu trách nhiệm tích hợp, báo cáo và Git; phần lõi và frontend được giao thực hiện song song, sau đó có lượt rà soát độc lập trước bàn giao.

## Kết quả kiểm tra môi trường

| Lệnh | Kết quả thực tế |
|---|---|
| `git status --short --branch` | `No commits yet on master`; hai tài liệu chưa được theo dõi |
| `git remote -v` | Fetch/push trỏ tới remote nêu trên |
| `git ls-remote origin` | Thành công, chưa có ref |
| `git log --oneline -10` | Chưa có commit; không có quy ước commit cũ để kế thừa |
| `go version` | `go1.26.2 windows/amd64` |
| `node --version` | `v22.14.0` |
| `wails version` | `v2.12.0` |
| `wails doctor` | Môi trường sẵn sàng phát triển Wails; WebView2 `158.0.4370.33`, npm `10.9.2` |
| `go env CGO_ENABLED CC` | CGO tắt (`0`), compiler mặc định `gcc` |
| `gcc --version` | Không tìm thấy trong PATH; cần compiler để chạy race detector |
| `gh auth status` | Không tìm thấy GitHub CLI trong PATH; thao tác push vẫn có thể dùng Git |

Đã có danh tính tác giả Git trong cấu hình máy, không cần sửa cấu hình Git. Không thay đổi môi trường toàn cục hoặc thiết lập đăng nhập trong giai đoạn này.

## Quy tắc bàn giao tiếp theo

1. Chỉ chốt mốc khi có lệnh kiểm chứng và kết quả thật; ghi rõ kiểm tra chưa chạy hoặc bị chặn.
2. Báo cáo trong `reports/` phải nêu phạm vi, thay đổi, kết quả đạt được, giới hạn, lỗi đã xử lý và bước tiếp theo.
3. Rà soát diff, trạng thái và lịch sử trước commit; chỉ stage tệp thuộc mốc; không đưa dependency cache, binary hoặc thông tin bí mật vào Git.
4. Commit có tiêu đề và nội dung chi tiết về hành vi, kiểm chứng và giới hạn; push `origin/master` khi mốc hoàn thành. Nếu dùng nhánh phụ, kiểm chứng trước khi merge về `master`.
5. Không coi build thành công là bằng chứng giao diện đã được kiểm tra trực quan hoặc các nền tảng khác đã được kiểm thử.

## Rủi ro và xử lý

- Race detector: tìm compiler hiện có hoặc dùng compiler portable trong thư mục tạm; nếu không chạy được phải ghi rõ, không báo pass.
- Tính toàn vẹn file: v0.1 dùng file tạm riêng, chống ghi đè và kiểm thử SHA-256; chia đoạn/khôi phục chỉ bổ sung ở các mốc sau.
- Vòng đời đồng thời: kiểm tra hủy tác vụ đang chạy và đang chờ, đóng manager khi không có consumer sự kiện, phát hiện rò rỉ goroutine.
- Quyền ghi file từ UI: chỉ chấp nhận thư mục mặc định hoặc thư mục được người dùng chọn bằng hộp thoại hệ thống.
- Tích hợp Go/WebView: sinh binding từ Go; đăng ký event trước khi lấy snapshot và xử lý các event tới trong quá trình đồng bộ.
- Đa nền tảng: máy hiện tại là Windows; CI ma trận và kiểm thử máy thật phải được ghi nhận riêng.
- Ký số v1.0: chưa có chứng chỉ hay tài khoản ký số trong repository; đây là phụ thuộc bên ngoài ở giai đoạn phát hành.

## Khôi phục

Commit tài liệu ban đầu giữ nguyên thiết kế gốc làm mốc đối chiếu. Các commit chức năng sau có thể được hoàn tác bằng một commit `git revert` khi cần, không viết lại lịch sử hoặc xóa thay đổi của người khác.
