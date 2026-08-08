# Build macOS (Apple Silicon)

Máy **Windows không build được** bản cài macOS. Cần Mac M1/M2/M3/M4 hoặc GitHub Actions (`macos-latest`).

## Trên Mac (M1–M4)

```bash
npm ci
npm run dist:mac
```

File ra: `dist/ZaloWorkDigest-0.1.0-mac-arm64.dmg`

### Cài đặt trên Mac

1. Mở file `.dmg`
2. Kéo **Zalo Work Digest** vào **Applications**
3. Lần đầu: Chuột phải app → **Open** → Open (vì bản chưa ký Apple Developer)

## GitHub Actions

Push tag `v*` hoặc chạy workflow **Build macOS arm64** (Actions → Run workflow).
Artifact DMG sẽ có trong trang run.

## Ghi chú

- Chỉ **arm64** (Apple Silicon). Không gồm Intel Mac.
- AI brain + CLI được vendor trên máy build Mac.
- Muốn ký notarize: cần Apple Developer ID, bỏ `"identity": null` trong `package.json`.
