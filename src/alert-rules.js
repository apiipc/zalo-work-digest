/** Parse comma/semicolon separated keywords. */
export function parseKeywords(raw) {
  return String(raw || "")
    .split(/[,;|\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Match enabled alert rules against an inbound message.
 * - match_any=1: khớp nếu được tag HOẶC có từ khóa (chỉ cần một)
 * - match_any=0 + match_mention=1: cần tag; nếu có từ khóa thì cũng cần từ khóa
 * - chỉ từ khóa: khớp khi nội dung chứa từ khóa
 */
export function matchRules(message, rules = []) {
  if (!message || message.isSelf) return [];
  const content = String(message.content || "").toLowerCase();
  const groupId = String(message.groupId || "");
  const isMention = Boolean(message.isMention);
  const hits = [];
  for (const rule of rules) {
    if (!rule || Number(rule.enabled) === 0) continue;
    const ruleGroup = String(rule.group_id || "*");
    if (ruleGroup !== "*" && ruleGroup !== groupId) continue;

    const keywords = parseKeywords(rule.keywords);
    const hasKeywords = keywords.length > 0;
    const wantMention = Number(rule.match_mention) === 1;
    const matchAny = Number(rule.match_any) === 1;
    const keywordHit = hasKeywords && keywords.some(kw => content.includes(kw.toLowerCase()));

    if (matchAny) {
      // Tag hoặc từ khóa — match_any luôn coi tag là một nhánh.
      if (!isMention && !keywordHit) continue;
      if (!hasKeywords && !isMention) continue;
      hits.push(rule);
      continue;
    }

    if (!wantMention && !hasKeywords) continue;
    if (wantMention && !isMention) continue;
    if (hasKeywords && !keywordHit) continue;
    hits.push(rule);
  }
  return hits;
}

export function formatRuleBotMessage({ rule, message, threadName }) {
  const prio = rule.priority === "high" ? "ƯU TIÊN" : "Cảnh báo";
  const who = message.senderName || message.sender_name || "Ai đó";
  const where = threadName || message.groupId || "cuộc trò chuyện";
  const excerpt = String(message.content || "").replace(/\s+/g, " ").trim().slice(0, 280);
  return `[${prio}] ${rule.name}\n${who} · ${where}\n${excerpt}`;
}
