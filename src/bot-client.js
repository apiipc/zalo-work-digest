const endpoint = (token, method) => `https://bot-api.zaloplatforms.com/bot${encodeURIComponent(token)}/${method}`;

async function call(token, method, body = {}, { timeoutMs = 15000 } = {}) {
  const response = await fetch(endpoint(token, method), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.ok) throw new Error(json.description || json.message || `Bot API HTTP ${response.status}`);
  return json.result;
}
export const verifyBot = token => call(token, "getMe");
export const sendBotMessage = (token, chatId, text) => call(token, "sendMessage", { chat_id: chatId, text: String(text).slice(0, 2000) });
export async function discoverChats(token) {
  const chats = new Map();
  // Zalo documents `timeout` as a String. Poll briefly several times so the
  // user can press Discover first, then send the bot a message.
  for (let attempt = 0; attempt < 3 && !chats.size; attempt++) {
    let result;
    try {
      result = await call(token, "getUpdates", { timeout: "3" }, { timeoutMs: 10000 });
    } catch (error) {
      // Zalo returns error 408 when a long-poll window has no new update.
      if (!/request timeout/i.test(error.message)) throw error;
      continue;
    }
    // getUpdates returns one event object (`result.message.chat.id`) on Zalo;
    // accept arrays as well for forward compatibility.
    const items = Array.isArray(result) ? result : (Array.isArray(result?.updates) ? result.updates : (result ? [result] : []));
    for (const item of items) {
      const chat = item?.message?.chat || item?.chat || item?.sender || {};
      const id = chat.id || chat.chat_id || item?.message?.chat_id;
      if (id) chats.set(String(id), { id: String(id), name: chat.title || chat.name || chat.display_name || String(id) });
    }
  }
  return [...chats.values()];
}
