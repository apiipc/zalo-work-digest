# Zalo Work Digest

Ứng dụng local-first để theo dõi nhóm Zalo, gom tin nhắn / tin tag, xuất CSV, lịch tổng hợp và gửi báo cáo qua Zalo Bot. Hỗ trợ AI bằng API key hoặc CLI (Codex / Claude / Gemini) đã đóng gói trong bản cài Windows.

## Chạy thử (dev)

Yêu cầu Node.js 18+ (khuyến nghị 24).

```powershell
npm install
npm start
```

Mở `http://127.0.0.1:4782`, quét QR Zalo.

Hoặc cửa sổ Electron:

```powershell
npm run electron:dev
```

## Đóng gói installer Windows

Trên máy **build** (cần mạng lần đầu để tải Electron + CLI):

```powershell
npm install
npm run dist:win
```

Kết quả: `dist/ZaloWorkDigest-Setup-0.1.0.exe`.

File Setup **đã chứa**:
- Runtime Electron (Chromium + Node)
- Thư viện app (`express`, `zca-js`, …)
- CLI AI: Codex, Claude, Gemini (vendor sẵn)
- Icon ứng dụng + ảnh nền wizard cài đặt

User cuối chỉ chạy Setup → chọn thư mục cài (tuỳ chọn) → mở app → chọn **nơi lưu dữ liệu** → dùng. **Không cần** cài Node hay `npm install`.

Đăng nhập CLI AI lần đầu vẫn mở trình duyệt (OAuth tài khoản ChatGPT/Claude/Google) — không tải thêm gói.

## Dữ liệu

- Dev: mặc định `data/` trong project; cấu hình path tại `config/data-path.json`.
- Bản cài: cấu hình tại `%APPDATA%/zalo-work-digest/config/`; dữ liệu mặc định `Documents\ZaloWorkDigest` (đổi được trong Cài đặt).

## Kiểm thử

```powershell
npm test
npm run check
```

## Cảnh báo

zca-js mô phỏng Zalo Web (không chính thức). Rủi ro tài khoản: chỉ dùng thử nghiệm có kiểm soát.
