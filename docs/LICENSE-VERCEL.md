# License Portal trên Vercel

Quản lý / tạo / thu hồi mã kích hoạt qua web trên Vercel.

## 1. Tạo Redis miễn phí (Upstash)

1. Vào [https://upstash.com](https://upstash.com) → tạo Redis database  
2. Copy **REST URL** và **REST TOKEN**

## 2. Deploy lên Vercel

**Quan trọng:** Deploy từ **root repo** (file `vercel.json` ở gốc). Không đặt Root Directory = `license-portal` nếu đang dùng cấu hình gốc này.

### GitHub

1. Vercel → Project gắn repo `zalo-work-digest`
2. Root Directory: **để trống** (`.`)
3. Framework Preset: **Other**
4. Thêm Environment Variables → Redeploy

### CLI

```bash
npx vercel --prod
```

Khi sửa portal: `node scripts/sync-vercel-license.js` rồi commit.

## 3. Biến môi trường

| Biến | Ví dụ |
|------|--------|
| `LICENSE_SECRET` | cùng secret với app desktop |
| `LICENSE_ADMIN_PASSWORD` | mật khẩu trang admin |
| `UPSTASH_REDIS_REST_URL` | từ Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | từ Upstash |

## 4. Dùng

Mở `https://YOUR-PROJECT.vercel.app` → đăng nhập → tạo / copy / thu hồi mã.

API kích hoạt app: `POST /api/activate` body `{ "key": "ZWD1....", "machineId": "..." }`

## 5. Nối app desktop (tùy chọn)

```bash
set LICENSE_SERVER_URL=https://YOUR-PROJECT.vercel.app
```
