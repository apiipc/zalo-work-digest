/** Chế độ SaaS web (nhiều user) vs app local/Electron. */
export function isSaasMode() {
  const mode = String(process.env.ZALO_DIGEST_MODE || "").toLowerCase().trim();
  return mode === "saas" || mode === "web" || process.env.ZALO_DIGEST_SAAS === "1";
}

export function appMode() {
  return isSaasMode() ? "saas" : "local";
}
