export const AI_PROVIDER_LABELS = {
  openai: "OpenAI",
  gemini: "Gemini",
  claude: "Claude",
  custom: "Custom (OpenAI-compatible)",
  "codex-cli": "ChatGPT / Codex",
  "claude-cli": "Claude CLI",
  cliproxyapi: "AI brain",
  "9router": "AI brain",
  "antigravity-cli": "AI brain",
  "gemini-cli": "AI brain"
};

export const AI_API_IDS = ["openai", "gemini", "claude", "custom"];
export const AI_CLI_IDS = ["codex-cli", "claude-cli"];
export const AI_ACCOUNT_IDS = ["codex-cli", "claude-cli", "cliproxyapi"];

export const AI_API_PRESETS = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", label: "OpenAI" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.0-flash", label: "Gemini" },
  claude: { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-20250514", label: "Claude" },
  custom: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", label: "Custom (OpenAI-compatible)" }
};

export function aiProviderLabel(id) {
  return AI_PROVIDER_LABELS[id] || id || "AI";
}

export function isApiProviderId(id) {
  return AI_API_IDS.includes(normalizeProviderId(id));
}

export function normalizeProviderId(id, { saas = false } = {}) {
  const key = String(id || "").toLowerCase();
  if (saas) {
    if (["openai", "gpt", "chatgpt"].includes(key)) return "openai";
    if (["gemini", "google"].includes(key)) return "gemini";
    if (["claude", "anthropic"].includes(key)) return "claude";
    if (["custom", "deepseek", "glm", "openrouter"].includes(key)) return "custom";
    if (AI_API_IDS.includes(key)) return key;
    return key || "openai";
  }
  if (["gemini-cli", "antigravity-cli", "9router", "cliproxy", "cli-proxy-api"].includes(key)) {
    return "cliproxyapi";
  }
  // Local app: gemini alone used to mean AI brain; keep CLI remaps for legacy.
  if (key === "gemini" && !saas) {
    // If explicitly stored as gemini API in older builds — treat as cliproxy only for gemini-cli aliases above.
  }
  if (["codex", "deepseek", "glm"].includes(key)) return "codex-cli";
  return key || "codex-cli";
}
