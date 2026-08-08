import { callAiCli, isCliProvider } from "./ai-cli.js";

function clean(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function localDigest(messages, groupName = "Nhóm") {
  const texts = messages.filter(m => clean(m.content));
  if (!texts.length) return `Không có tin nhắn văn bản trong khoảng thời gian đã chọn.`;
  const tasks = texts.filter(m => /(giao|làm|hoàn thành|deadline|hạn|nhắc|kiểm tra|gửi|báo cáo|phụ trách)/i.test(m.content));
  const decisions = texts.filter(m => /(chốt|thống nhất|quyết định|đồng ý|xác nhận|duyệt)/i.test(m.content));
  const questions = texts.filter(m => /\?|ai |khi nào|bao giờ|được không|chưa vậy/i.test(m.content));
  const participants = [...new Set(texts.map(m => m.sender_name).filter(Boolean))];
  const render = (items, max = 8) => items.slice(-max).map(m => `- ${m.sender_name || "Thành viên"}: ${clean(m.content).slice(0, 240)}`).join("\n") || "- Chưa phát hiện";
  return [
    `BÁO CÁO: ${groupName}`,
    `Tổng số tin: ${texts.length} | Thành viên tham gia: ${participants.length}`,
    participants.length ? `Người tham gia: ${participants.join(", ")}` : "",
    "\nNội dung gần nhất đáng chú ý:", render(texts, 10),
    "\nCông việc/đề nghị:", render(tasks),
    "\nQuyết định/xác nhận:", render(decisions),
    "\nCâu hỏi cần theo dõi:", render(questions),
  ].filter(Boolean).join("\n");
}

export function aiReady(cfg) {
  if (!cfg?.enabled) return false;
  if (isCliProvider(cfg.provider)) return true;
  const provider = String(cfg.provider || "").toLowerCase();
  if (provider === "cliproxyapi") {
    return Boolean(cfg.baseUrl || cfg.apiKey);
  }
  if (["openai", "gemini", "claude", "anthropic", "custom"].includes(provider)) {
    return Boolean(cfg.apiKey);
  }
  return Boolean(cfg.apiKey);
}

// Tài khoản: Codex/Claude CLI, hoặc CLIProxyAPI (OpenAI-compatible local).
export async function callAI(cfg, systemPrompt, userPrompt) {
  const provider = (cfg.provider || "").toLowerCase();
  if (isCliProvider(provider)) return callAiCli({ ...cfg, provider }, systemPrompt, userPrompt);
  if (provider === "gemini") return callGemini(cfg, systemPrompt, userPrompt);
  if (provider === "claude" || provider === "anthropic") return callAnthropic(cfg, systemPrompt, userPrompt);
  return callOpenAICompatible(cfg, systemPrompt, userPrompt);
}

async function callOpenAICompatible(cfg, systemPrompt, userPrompt) {
  const base = (cfg.baseUrl || "").replace(/\/$/, "");
  const body = {
    model: cfg.model,
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  };
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`AI API trả về ${response.status}`);
  const json = await response.json();
  return json.choices?.[0]?.message?.content || "";
}

async function callGemini(cfg, systemPrompt, userPrompt) {
  const base = (cfg.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  const model = cfg.model || "gemini-2.0-flash";
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.2 }
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gemini trả về ${response.status}: ${detail.slice(0, 200)}`);
  }
  const json = await response.json();
  return json.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
}

async function callAnthropic(cfg, systemPrompt, userPrompt) {
  const base = (cfg.baseUrl || "https://api.anthropic.com/v1").replace(/\/$/, "");
  const response = await fetch(`${base}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: cfg.model || "claude-sonnet-5", max_tokens: 2000, temperature: 0.2,
      system: systemPrompt, messages: [{ role: "user", content: userPrompt }]
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Claude trả về ${response.status}: ${detail.slice(0, 200)}`);
  }
  const json = await response.json();
  return json.content?.filter(item => item.type === "text").map(item => item.text).join("") || "";
}

export async function createDigestWithConfig(messages, groupName, cfg) {
  if (!aiReady(cfg)) return localDigest(messages, groupName);
  const transcript = messages.map(m => `[${new Date(m.sent_at).toLocaleString("vi-VN")}] ${m.sender_name}: ${clean(m.content)}`).join("\n");
  try {
    const out = await callAI(cfg,
      `Bạn tổng hợp hội thoại công việc bằng tiếng Việt. Không bịa. Yêu cầu của người dùng: ${cfg.prompt || "Tóm tắt, quyết định, đầu việc, người phụ trách, thời hạn, câu hỏi tồn đọng và rủi ro."}`,
      `Nhóm: ${groupName}\n\n${transcript.slice(-80000)}`);
    return out || localDigest(messages, groupName);
  } catch (error) {
    // Giữ nút tổng hợp luôn hoạt động kể cả khi AI lỗi.
    return `${localDigest(messages, groupName)}\n\n[Ghi chú: AI chưa dùng được (${error.message}), đã dùng bộ tổng hợp cục bộ.]`;
  }
}

// Giữ tương thích với cấu hình từ biến môi trường.
export async function createDigest(messages, groupName) {
  const { AI_BASE_URL, AI_API_KEY, AI_MODEL } = process.env;
  if (!AI_BASE_URL || !AI_API_KEY || !AI_MODEL) return localDigest(messages, groupName);
  return createDigestWithConfig(messages, groupName, {
    enabled: true, provider: "openai", baseUrl: AI_BASE_URL, apiKey: AI_API_KEY, model: AI_MODEL
  });
}
