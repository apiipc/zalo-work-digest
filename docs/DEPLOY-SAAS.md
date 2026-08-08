# Deploy SaaS — Zalo Work Digest

Chạy dạng web app: người dùng mở trình duyệt, đăng ký/đăng nhập, quét QR Zalo, cấu hình AI bằng API key — **không cần cài Electron**.

## Yêu cầu

- Node.js 22+ (hoặc 20+)
- VPS / máy chủ luôn bật (WebSocket Zalo cần process dài)
- Domain + HTTPS (khuyến nghị Caddy hoặc Nginx)

## Biến môi trường

| Biến | Bắt buộc | Mô tả |
|------|----------|--------|
| `ZALO_DIGEST_MODE=saas` | Có | Bật chế độ SaaS |
| `SAAS_SECRET` | Có | Chuỗi bí mật ≥ 16 ký tự (mã hóa API key + session) |
| `HOST` | Không | Mặc định `0.0.0.0` |
| `PORT` | Không | Mặc định `4782` |
| `ZALO_DIGEST_DATA` | Không | Thư mục dữ liệu (mặc định `./data`) |
| `SAAS_SECURE_COOKIES=1` | Nên khi HTTPS | Cookie `Secure` |

## Chạy local / VPS

```bash
cp .env.saas.example .env   # tùy chọn
export ZALO_DIGEST_MODE=saas
export SAAS_SECRET='thay-bang-chuoi-bi-mat-dai'
export HOST=0.0.0.0
export PORT=4782
npm ci
npm run start:saas
```

Mở `http://SERVER:4782` → Đăng ký → Đăng nhập Zalo QR → Cài đặt AI (OpenAI / Gemini / Claude / Custom).

## Reverse proxy (Caddy)

```caddyfile
digest.example.com {
  reverse_proxy 127.0.0.1:4782
}
```

Rồi bật `SAAS_SECURE_COOKIES=1`.

## Dữ liệu trên đĩa

```text
data/
  saas.db                 # users + sessions
  tenants/<userId>/       # SQLite + session Zalo từng khách
```

Sao lưu định kỳ cả thư mục `data/`.

## Lưu ý

- Session Zalo trên server dùng thư viện không chính thức — có rủi ro ToS.
- Mỗi user online giữ kết nối Zalo → cần RAM đủ theo số user đồng thời.
- App desktop Electron vẫn chạy chế độ `local` như cũ (`npm start` / installer).
