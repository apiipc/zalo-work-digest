export function messagesCsv(messages) {
  const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = [["Thời gian","Nhóm/cuộc trò chuyện","Người gửi","Nội dung","Loại","Tag tôi"]];
  for (const m of messages) rows.push([new Date(m.sent_at).toLocaleString("vi-VN"),m.thread_name || m.group_name || m.group_id,m.sender_name,m.content,m.thread_type,m.is_mention ? "Có" : "Không"]);
  return "\uFEFF" + rows.map(row => row.map(quote).join(",")).join("\r\n");
}

// CSV đầy đủ: bổ sung ID tin, ID người gửi, ID cuộc trò chuyện, thông tin ảnh/tệp.
export function messagesCsvFull(messages, assetsByMessage = {}) {
  const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = [[
    "Thời gian","Nhóm/cuộc trò chuyện","ID cuộc trò chuyện","Người gửi","ID người gửi",
    "Nội dung","Loại có thể","Loại cuộc trò chuyện","Tag tôi","Ảnh/tệp","Đường dẫn tệp","URL gốc","Loại tệp","Kích thước"
  ]];
  for (const m of messages) {
    const assets = assetsByMessage[m.id] || [];
    const assetText = assets.map(a => a.name).join("; ") || "";
    const assetPath = assets.map(a => a.file_path).join("; ") || "";
    const assetUrl = assets.map(a => a.web_url).join("; ") || "";
    const assetMime = assets.map(a => a.mime).join("; ") || "";
    const assetSize = assets.map(a => a.size).join("; ") || "";
    rows.push([
      new Date(m.sent_at).toLocaleString("vi-VN"),
      m.thread_name || m.group_name || m.group_id,
      m.group_id, m.sender_name, m.sender_id,
      m.content, m.message_type || "text", m.thread_type,
      m.is_mention ? "Có" : "Không",
      assetText, assetPath, assetUrl, assetMime, assetSize
    ]);
  }
  return "\uFEFF" + rows.map(row => row.map(quote).join(",")).join("\r\n");
}
