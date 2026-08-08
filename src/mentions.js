export function buildMentionMessage(content, selectedMembers) {
  const prefixes = [];
  const mentions = [];
  let cursor = 0;
  for (const member of selectedMembers || []) {
    const label = `@${member.name}`;
    prefixes.push(label);
    mentions.push({ pos: cursor, len: label.length - 1, uid: String(member.id) });
    cursor += label.length + 1;
  }
  const prefix = prefixes.join(" ");
  return { msg: prefix ? `${prefix} ${content}` : content, mentions };
}
