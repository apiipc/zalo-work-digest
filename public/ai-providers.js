export const AI_PRESETS = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", label: "OpenAI", mode: "api" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.0-flash", label: "Gemini", mode: "api" },
  claude: { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-20250514", label: "Claude", mode: "api" },
  custom: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", label: "Custom (OpenAI-compatible)", mode: "api" },
  "codex-cli": { baseUrl: "", model: "codex-cli", label: "ChatGPT / Codex", mode: "cli" },
  "claude-cli": { baseUrl: "", model: "claude-cli", label: "Claude", mode: "cli" },
  cliproxyapi: {
    baseUrl: "http://127.0.0.1:8317/v1",
    model: "gemini-2.5-flash",
    label: "AI brain",
    mode: "account"
  },
  "9router": {
    baseUrl: "http://127.0.0.1:8317/v1",
    model: "gemini-2.5-flash",
    label: "AI brain",
    mode: "account"
  },
  "antigravity-cli": {
    baseUrl: "http://127.0.0.1:8317/v1",
    model: "gemini-2.5-flash",
    label: "AI brain",
    mode: "account"
  },
  "gemini-cli": {
    baseUrl: "http://127.0.0.1:8317/v1",
    model: "gemini-2.5-flash",
    label: "AI brain",
    mode: "account"
  }
};

export const AI_ACCOUNT_IDS = ["codex-cli", "claude-cli", "cliproxyapi"];
export const AI_CLI_IDS = ["codex-cli", "claude-cli"];
export const AI_API_IDS = ["openai", "gemini", "claude", "custom"];

export function aiProviderLabel(id) {
  return AI_PRESETS[id]?.label || id || "AI";
}

export function normalizeProviderId(id, { saas = false } = {}) {
  const key = String(id || "").toLowerCase();
  if (saas || AI_API_IDS.includes(key) || ["gpt", "chatgpt", "google", "anthropic", "deepseek", "glm", "openrouter"].includes(key)) {
    if (["openai", "gpt", "chatgpt"].includes(key)) return "openai";
    if (["gemini", "google"].includes(key)) return "gemini";
    if (["claude", "anthropic"].includes(key)) return "claude";
    if (["custom", "deepseek", "glm", "openrouter"].includes(key)) return key === "custom" ? "custom" : "custom";
    if (AI_API_IDS.includes(key)) return key;
  }
  if (["gemini-cli", "antigravity-cli", "9router", "cliproxy", "cli-proxy-api"].includes(key)) {
    return "cliproxyapi";
  }
  if (["codex", "deepseek", "glm"].includes(key)) return "codex-cli";
  return key || (saas ? "openai" : "codex-cli");
}

export function isCliProviderId(id) {
  const key = normalizeProviderId(id);
  return key === "codex-cli" || key === "claude-cli";
}

export function isAccountProviderId(id) {
  const key = normalizeProviderId(id);
  return AI_ACCOUNT_IDS.includes(key);
}

export function isApiProviderId(id) {
  return AI_API_IDS.includes(normalizeProviderId(id, { saas: true }));
}
