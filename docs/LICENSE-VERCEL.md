# License Portal trên Vercel

Quản lý / tạo / thu hồi mã kích hoạt qua web trên Vercel (không chạy app Zalo trên Vercel).

## 1. Tạo Redis miễn phí (Upstash)

1. Vào [https://upstash.com](https://upstash.com) → tạo Redis database  
2. Copy **REST URL** và **REST TOKEN**

## 2. Deploy lên Vercel

### Cách A — CLI

```bash
cd license-portal
npx vercel
```

Root Directory khi import GitHub: chọn `license-portal`.

### Cách B — GitHub

1. Repo đã có sẵn: `https://github.com/apiipc/zalo-work-digest`  
2. Vercel → Add New Project → chọn repo  
3. **Root Directory** = `license-portal`  
4. Deploy

## 3. Biến môi trường (Vercel → Settings → Environment Variables)

| Biến | Ví dụ |
|------|--------|
| `LICENSE_SECRET` | cùng secret với app desktop (quan trọng!) |
| `LICENSE_ADMIN_PASSWORD` | mật khẩu trang admin của bạn |
| `UPSTASH_REDIS_REST_URL` | từ Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | từ Upstash |

Redeploy sau khi thêm env.

## 4. Dùng

Mở `https://YOUR-PROJECT.vercel.app` → đăng nhập mật khẩu admin → tạo mã trial/vĩnh viễn → Copy gửi khách.

API kích hoạt (app desktop gọi được):

`POST https://YOUR-PROJECT.vercel.app/api/activate`  
Body: `{ "key": "ZWD1....", "machineId": "..." }`  
→ nếu mã **revoked** trên Vercel sẽ bị từ chối.

## 5. Nối app desktop (tùy chọn)

Trước khi build/chạy app:

```bash
set LICENSE_SERVER_URL=https://YOUR-PROJECT.vercel.app
```

(hoặc thêm vào môi trường Electron). App sẽ kiểm tra thu hồi trên cloud khi kích hoạt mã.
