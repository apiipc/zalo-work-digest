# Quản lý mã kích hoạt

Có **2 cách**:

## A) Trên Vercel (khuyến nghị — quản lý từ xa)

Xem chi tiết: [LICENSE-VERCEL.md](./LICENSE-VERCEL.md)

Tóm tắt:
1. Tạo Redis miễn phí trên [Upstash](https://upstash.com)
2. Deploy thư mục `license-portal` lên Vercel
3. Set env: `LICENSE_SECRET`, `LICENSE_ADMIN_PASSWORD`, `UPSTASH_REDIS_REST_*`
4. Mở `https://your-app.vercel.app` → đăng nhập → tạo / copy / thu hồi mã

## B) Trên máy bạn (localhost)

```bash
npm run license:admin
```

Sổ mã: `licenses/issued.json`

```bash
npm run license:trial5
npm run license:lifetime
npm run license:list
```

## Khách dùng mã

Mở app → dán `ZWD1....` vào màn kích hoạt (hoặc Cài đặt → Bản quyền).

Nếu app có `LICENSE_SERVER_URL` trỏ về Vercel portal, mã **đã thu hồi** trên web sẽ không kích hoạt được.
