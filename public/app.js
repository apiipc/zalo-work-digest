const $ = s => document.querySelector(s);
import { applyUiScale, initUiScaleSelect, readUiScale } from "./ui-scale.js";
import { AI_PRESETS, AI_API_IDS, aiProviderLabel, isApiProviderId, isCliProviderId, normalizeProviderId } from "./ai-providers.js";

let appFeatures = { auth: false, aiApi: true, aiCli: true, aiBrain: true, dataLocation: true };
let saasMode = false;
let saasUser = null;

function getAiProvider() {
  return normalizeProviderId($("#aiProvider")?.value || (saasMode ? "openai" : "codex-cli"), { saas: saasMode });
}

function isCliProxyProvider(id = getAiProvider()) {
  return normalizeProviderId(id) === "cliproxyapi";
}

function syncAiVisibleFieldsFromHidden() {
  if ($("#aiBaseUrlVisible") && $("#aiBaseUrl")) $("#aiBaseUrlVisible").value = $("#aiBaseUrl").value || "";
  if ($("#aiModelVisible") && $("#aiModel")) $("#aiModelVisible").value = $("#aiModel").value || "";
}

function syncAiHiddenFromVisible() {
  if ($("#aiBaseUrlVisible") && $("#aiBaseUrl")) $("#aiBaseUrl").value = $("#aiBaseUrlVisible").value || "";
  if ($("#aiModelVisible") && $("#aiModel")) $("#aiModel").value = $("#aiModelVisible").value || "";
  if ($("#aiApiKeyVisible") && $("#aiApiKey")) $("#aiApiKey").value = $("#aiApiKeyVisible").value || "";
}

async function setAiProvider(id, { refresh = true } = {}) {
  const provider = normalizeProviderId(id, { saas: saasMode });
  const input = $("#aiProvider");
  if (input) input.value = provider;
  document.querySelectorAll(".ai-pick").forEach(btn => {
    btn.classList.toggle("active", normalizeProviderId(btn.dataset.provider, { saas: saasMode }) === provider);
  });
  const preset = AI_PRESETS[provider];
  if (preset) {
    if (preset.baseUrl != null && $("#aiBaseUrl")) $("#aiBaseUrl").value = preset.baseUrl;
    if (preset.model != null && $("#aiModel")) $("#aiModel").value = preset.model;
  }
  syncAiVisibleFieldsFromHidden();
  toggleAiMode();
  if (!refresh) return;
  try {
    const c = await api("/api/ai-config");
    await updateAiStatusCard({ ...c, provider });
  } catch {
    await updateAiStatusCard({ provider, enabled: $("#aiEnabled").checked, configured: false });
  }
}
const api = async (url, options = {}) => {
  const r = await fetch(url, { headers: { "content-type": "application/json" }, credentials: "same-origin", ...options });
  const data = await r.json().catch(() => ({}));
  if (r.status === 402 || data.code === "license_required") {
    showLicenseGate(data.license || null);
    throw new Error(data.error || "Cần mã kích hoạt");
  }
  if (r.status === 401 && (data.code === "auth_required" || saasMode) && !String(url).includes("/api/auth/")) {
    location.replace("/login.html");
    throw new Error(data.error || "Cần đăng nhập");
  }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};

function formatLicenseWhen(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("vi-VN");
}

function licenseMetaHtml(lic) {
  if (!lic) return "";
  const rows = [];
  rows.push(["Trạng thái", lic.label || "—"]);
  if (lic.type === "lifetime") {
    rows.push(["Loại", "Vĩnh viễn"]);
  } else if (lic.type === "trial") {
    rows.push(["Loại", "Dùng thử"]);
    rows.push(["Số ngày còn lại", lic.daysLeft == null ? "—" : String(lic.daysLeft)]);
  }
  rows.push(["Ngày kích hoạt", formatLicenseWhen(lic.activatedAt)]);
  if (lic.expiresAt) rows.push(["Hết hạn", formatLicenseWhen(lic.expiresAt)]);
  if (lic.keyPreview) rows.push(["Mã", lic.keyPreview]);
  return rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("");
}

function showLicenseGate(license) {
  const gate = $("#licenseGate");
  if (!gate) return;
  gate.classList.remove("hidden");
  document.body.classList.add("license-locked");
  if (license) {
    if ($("#licenseGateMessage")) $("#licenseGateMessage").textContent = license.message || "Cần mã kích hoạt.";
    if ($("#licenseGateStatus")) {
      const parts = [];
      if (license.label) parts.push(license.label);
      if (license.activatedAt) parts.push(`Kích hoạt: ${formatLicenseWhen(license.activatedAt)}`);
      if (license.daysLeft != null && license.type === "trial") parts.push(`Còn ${license.daysLeft} ngày`);
      if (license.expiresAt) parts.push(`Hết hạn: ${formatLicenseWhen(license.expiresAt)}`);
      $("#licenseGateStatus").textContent = parts.join(" · ");
    }
  }
}

function hideLicenseGate() {
  $("#licenseGate")?.classList.add("hidden");
  document.body.classList.remove("license-locked");
}

async function loadLicense() {
  const lic = await fetch("/api/license").then(r => r.json());
  if ($("#licenseSettingsLabel")) $("#licenseSettingsLabel").textContent = lic.label || "—";
  if ($("#licenseSettingsMessage")) $("#licenseSettingsMessage").textContent = lic.message || "";
  if ($("#licenseSettingsMeta")) $("#licenseSettingsMeta").innerHTML = licenseMetaHtml(lic);
  return lic;
}

async function activateLicenseFromInput(inputEl, noticeEl) {
  const key = String(inputEl?.value || "").trim();
  if (!key) throw new Error("Nhập mã kích hoạt");
  const r = await fetch("/api/license/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Kích hoạt thất bại");
  if (noticeEl) noticeEl.textContent = data.message || "Đã kích hoạt.";
  if (inputEl) inputEl.value = "";
  await loadLicense().catch(() => {});
  if (data.ok) {
    hideLicenseGate();
    showNotice("Đã kích hoạt bản quyền.", "success");
    status().catch(console.error);
    loadDashboard().catch(console.error);
  } else {
    showLicenseGate(data);
  }
  return data;
}
let groups = [];
let contacts = [];
let dailyTimes = ["08:00"];
let alertsCache = [];
let alertsCollapsed = false;
let noticeTimer;

function isTrivialAlertContent(text) {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) return true;
  // Ẩn các tin cực ngắn/không mang nghĩa công việc.
  if (/^[0-9]{1,2}$/.test(raw)) return true;
  if (/^(ok|oke|kk|k|uh|uhm|v|dạ|da|yes|no|\.)$/.test(raw)) return true;
  if (/^[\p{Emoji}\p{Extended_Pictographic}\s]+$/u.test(raw)) return true;
  return false;
}
function showNotice(message, type = "info") {
  const notice = $("#webNotice");
  notice.textContent = message; notice.className = `web-notice ${type}`;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => notice.classList.add("hidden"), 6000);
}
function requireSecondClick(button, message) {
  if (button.dataset.confirming === "true") return true;
  button.dataset.confirming = "true"; button.dataset.originalText = button.textContent;
  button.textContent = "Bấm lần nữa để xác nhận"; button.classList.add("confirming"); showNotice(message);
  setTimeout(() => { if (button.isConnected) { button.dataset.confirming = "false"; button.textContent = button.dataset.originalText || "Xóa lịch"; button.classList.remove("confirming"); } }, 5000);
  return false;
}
function showPage(pageId) {
  document.querySelectorAll(".page").forEach(x => x.classList.add("hidden"));
  const page = $(`#${pageId}`);
  if (!page) return;
  page.classList.remove("hidden");
  page.classList.remove("page");
  void page.offsetWidth;
  page.classList.add("page");
}

document.querySelectorAll(".nav").forEach(btn => btn.onclick = () => {
  document.querySelectorAll(".nav").forEach(x => x.classList.toggle("active", x === btn));
  showPage(btn.dataset.page);
  $("#title").textContent = btn.textContent;
  if (btn.dataset.page === "dashboard") loadDashboard();
  if (btn.dataset.page === "schedules") loadSchedules();
  if (btn.dataset.page === "notifications") { ensureAlertDefaults(); fillAlertFilterGroups(); loadAlerts(); loadAlertRules(); loadDigestSchedules(); }
  if (btn.dataset.page === "settings") { loadLicense().catch(console.error); loadBot(); loadAi(); if (appFeatures.dataLocation) loadDataLocation(); }
});

function clearZaloUi(message) {
  groups = [];
  contacts = [];
  alertsCache = [];
  chartBuckets = [];
  if ($("#enabledCount")) $("#enabledCount").textContent = "0";
  if ($("#messageCount")) $("#messageCount").textContent = "0";
  if ($("#scheduleCount")) $("#scheduleCount").textContent = "0";
  if ($("#groupList")) $("#groupList").innerHTML = "Chưa kết nối Zalo. Đăng nhập QR để xem nhóm.";
  if ($("#reportGroup")) $("#reportGroup").innerHTML = "";
  if ($("#scheduleGroup")) $("#scheduleGroup").innerHTML = "";
  if ($("#scheduleContact")) $("#scheduleContact").innerHTML = "";
  if ($("#memberList")) $("#memberList").innerHTML = "";
  if ($("#digestScheduleGroup")) $("#digestScheduleGroup").innerHTML = `<option value="*">Tất cả nhóm đang theo dõi</option>`;
  if ($("#digestScheduleList")) $("#digestScheduleList").innerHTML = "";
  if ($("#scheduleList")) $("#scheduleList").innerHTML = "Chưa kết nối Zalo.";
  if ($("#alertList")) $("#alertList").innerHTML = "Chưa kết nối Zalo.";
  if ($("#alertGroup")) $("#alertGroup").innerHTML = `<option value="">Tất cả nhóm / chat</option>`;
  if ($("#ruleGroup")) $("#ruleGroup").innerHTML = `<option value="*">Tất cả nhóm đang theo dõi</option>`;
  if ($("#dashRecentList")) $("#dashRecentList").innerHTML = `<div class="row-item empty">Chưa kết nối Zalo.</div>`;
  if ($("#dashAttentionList")) $("#dashAttentionList").innerHTML = `<div class="row-item empty">Chưa kết nối Zalo.</div>`;
  if ($("#dashScheduleList")) $("#dashScheduleList").innerHTML = `<div class="compact-row"><div><strong>Chưa kết nối</strong><span>Đăng nhập QR để xem lịch</span></div></div>`;
  if ($("#dashReportList")) $("#dashReportList").innerHTML = `<div class="compact-row"><div><strong>Chưa kết nối</strong><span>Đăng nhập QR để xem nhóm</span></div></div>`;
  if ($("#dashHourChart")) $("#dashHourChart").innerHTML = `<div class="row-item empty">Chưa kết nối Zalo.</div>`;
  if ($("#dashPeakHour")) $("#dashPeakHour").textContent = "—";
  if ($("#dashAvgPerHour")) $("#dashAvgPerHour").textContent = "0 tin";
  if ($("#dashTotalToday")) $("#dashTotalToday").textContent = "0 tin";
  if ($("#digestOutput")) $("#digestOutput").textContent = "Chưa có báo cáo.";
  $("#dashChartMessages")?.classList.add("hidden");
  if (message) showNotice(message, "success");
}

let zaloOnline = false;
let zaloUserId = "";
async function status() {
  const s = await api("/api/status");
  const online = s.status === "online";
  const wasOnline = zaloOnline;
  const nextId = String(s.profile?.id || "");
  const switched = Boolean(online && nextId && zaloUserId && nextId !== zaloUserId) || Boolean(s.accountSwitched);
  zaloOnline = online;
  if (online && nextId) zaloUserId = nextId;
  const c = $("#connection");
  c.className = `connection ${online ? "online" : "offline"}`;
  c.textContent = online ? `● Đã kết nối${s.profile?.name ? ` — ${s.profile.name}` : ""}` : `● ${s.error || "Chưa kết nối Zalo"}`;
  $("#loginCard").classList.toggle("hidden", online);
  $("#logoutBtn").classList.toggle("hidden", !online);
  $("#zaloGateNotice")?.classList.toggle("hidden", online);
  document.body.classList.toggle("zalo-offline", !online);
  if (s.qr) $("#qrArea").innerHTML = `<img alt="QR đăng nhập Zalo" src="${s.qr}"><small>Quét và xác nhận trên điện thoại</small>`;
  if (wasOnline && !online) clearZaloUi();
  if (switched) {
    clearZaloUi("Đã chuyển tài khoản Zalo — nhóm/tin/lịch theo tài khoản này. Cấu hình AI/Bot dùng chung.");
  }
  if (online && (switched || !groups.length || (!wasOnline && online))) {
    await loadGroups().catch(console.error);
    await Promise.all([
      loadSchedules().catch(console.error),
      loadDashboard().catch(console.error),
      loadDigestSchedules().catch(() => {})
    ]);
  }
  if (wasOnline !== online && $("#settings") && !$("#settings").classList.contains("hidden")) {
    await Promise.all([loadAi().catch(console.error), loadBot().catch(console.error)]);
  }
}

async function loadGroups() {
  groups = await api("/api/groups");
  $("#enabledCount").textContent = groups.filter(g => g.enabled).length;
  $("#groupList").innerHTML = groups.length ? groups.map(g => `<div class="group"><img class="avatar" src="${g.avatar || ""}" onerror="this.style.visibility='hidden'"><div><b>${escapeHtml(g.name)}</b><small>${g.member_count} thành viên · ID ${g.id}</small></div><input class="switch" type="checkbox" data-id="${g.id}" ${g.enabled ? "checked" : ""}></div>`).join("") : "Chưa có nhóm. Hãy kết nối và đồng bộ.";
  document.querySelectorAll(".switch").forEach(x => x.onchange = async () => { await api(`/api/groups/${x.dataset.id}`, { method: "PATCH", body: JSON.stringify({ enabled: x.checked }) }); await loadGroups(); });
  const opts = groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");
  $("#reportGroup").innerHTML = opts; renderScheduleGroups();
  $("#digestScheduleGroup").innerHTML = `<option value="*">Tất cả nhóm đang theo dõi</option>${opts}`;
  fillAlertFilterGroups();
  if (groups.length) await loadMembers();
}
function fillAlertFilterGroups() {
  const opts = groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("");
  const alertGroup = $("#alertGroup");
  if (alertGroup) {
    const cur = alertGroup.value;
    alertGroup.innerHTML = `<option value="">Tất cả nhóm / chat</option>${opts}`;
    if ([...alertGroup.options].some(o => o.value === cur)) alertGroup.value = cur;
  }
  const ruleGroup = $("#ruleGroup");
  if (ruleGroup) {
    const cur = ruleGroup.value;
    ruleGroup.innerHTML = `<option value="*">Tất cả nhóm đang theo dõi</option>${opts}`;
    if ([...ruleGroup.options].some(o => o.value === cur)) ruleGroup.value = cur;
  }
}
function toLocalInputValue(ms) {
  const d = new Date(ms);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
function ensureAlertDefaults() {
  const from = $("#alertFrom"), to = $("#alertTo");
  if (from && !from.value) from.value = toLocalInputValue(Date.now() - 86400000);
  if (to && !to.value) to.value = toLocalInputValue(Date.now());
}
function alertFilterParams() {
  ensureAlertDefaults();
  const from = $("#alertFrom")?.value ? new Date($("#alertFrom").value).getTime() : Date.now() - 86400000;
  const to = $("#alertTo")?.value ? new Date($("#alertTo").value).getTime() : Date.now();
  const params = new URLSearchParams({ from: String(from), to: String(to), limit: "500" });
  const groupId = $("#alertGroup")?.value || "";
  const q = $("#alertKeyword")?.value?.trim() || "";
  const kind = $("#alertKind")?.value || "";
  const senderRaw = $("#alertSender")?.value?.trim() || "";
  if (groupId) params.set("groupId", groupId);
  if (q) params.set("q", q);
  if (kind) params.set("kind", kind);
  if (senderRaw) {
    const contact = (contacts || []).find(c =>
      normalizeSearch(c.display_name) === normalizeSearch(senderRaw)
      || normalizeSearch(c.display_name).includes(normalizeSearch(senderRaw)));
    if (contact) params.set("senderId", contact.user_id);
  }
  return { params, senderName: senderRaw };
}
function normalizeSearch(value) { return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim(); }
function renderScheduleGroups() {
  const query = normalizeSearch($("#groupSearch")?.value), current = $("#scheduleGroup").value;
  const filtered = groups.filter(group => normalizeSearch(group.name).includes(query));
  $("#scheduleGroup").innerHTML = filtered.map(group => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("") || `<option value="">Không tìm thấy nhóm</option>`;
  if (filtered.some(group => group.id === current)) $("#scheduleGroup").value = current;
}
async function loadMembers() {
  const id = $("#scheduleGroup").value;
  $("#memberList").textContent = id ? "Đang tải thành viên…" : "Chưa chọn nhóm.";
  const members = id ? await api(`/api/groups/${id}/members`) : [];
  $("#memberList").innerHTML = members.map(m => `<label class="member"><input type="checkbox" value="${m.user_id}" data-name="${escapeHtml(m.display_name)}"> ${escapeHtml(m.display_name)}</label>`).join("") || "Chưa có dữ liệu thành viên.";
}
async function loadContacts() {
  contacts = await api("/api/contacts");
  renderContacts();
}
function renderContacts() {
  const query = normalizeSearch($("#contactSearch")?.value), current = $("#scheduleContact").value;
  const filtered = contacts.filter(contact => normalizeSearch(contact.display_name).includes(query));
  $("#scheduleContact").innerHTML = filtered.map(contact => `<option value="${contact.user_id}">${escapeHtml(contact.display_name)}</option>`).join("") || `<option value="">Không tìm thấy liên hệ</option>`;
  if (filtered.some(contact => contact.user_id === current)) $("#scheduleContact").value = current;
}
async function loadSchedules() {
  const jobs = await api("/api/schedules");
  const needContacts = jobs.some(job => job.target_type === "user");
  if (needContacts && !contacts.length) {
    try { await loadContacts(); } catch {}
  }
  const groupById = new Map((groups || []).map(g => [String(g.id), g.name]));
  const contactById = new Map((contacts || []).map(c => [String(c.user_id), c.display_name]));
  const targetLabel = job => {
    const id = String(job.group_id || "");
    if (job.target_type === "user") return contactById.get(id) || `Người dùng ${id}`;
    return groupById.get(id) || (id === "*" ? "Tất cả nhóm" : `Nhóm ${id}`);
  };
  const scheduleStatusClass = status => {
    const s = String(status || "").toLowerCase();
    if (s === "sent") return "status--sent";
    if (s === "pending") return "status--pending";
    if (s === "failed") return "status--failed";
    if (s === "running") return "status--running";
    return "";
  };
  $("#scheduleCount").textContent = jobs.length;
  $("#scheduleList").innerHTML = jobs.map(j => `<div class="schedule-row"><span class="status ${scheduleStatusClass(j.status)}">${j.status}</span> ${j.target_type === "user" ? "Cá nhân" : "Nhóm"}: <b>${escapeHtml(targetLabel(j))}</b> · ${new Date(j.run_at).toLocaleString("vi-VN")} ${j.recurrence === "daily" ? "· lặp hằng ngày" : "· gửi một lần"} · ${escapeHtml(j.content)}${j.last_error ? `<small> — ${escapeHtml(j.last_error)}</small>` : ""}${j.status === "pending" ? ` <button class="secondary delete-schedule" data-id="${j.id}">Xóa lịch</button>` : ""}</div>`).join("") || "Chưa có lịch gửi.";
  document.querySelectorAll(".delete-schedule").forEach(button => button.onclick = async () => {
    if (!requireSecondClick(button, "Bấm lại nút xóa trong 5 giây để xác nhận.")) return;
    try { await api(`/api/schedules/${button.dataset.id}`, { method: "DELETE" }); showNotice("Đã xóa lịch chưa gửi.", "success"); await loadSchedules(); }
    catch (error) { showNotice(error.message, "error"); }
  });
}
function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function renderAlerts(rows = alertsCache) {
  const list = $("#alertList");
  if (!list) return;
  list.classList.toggle("collapsed", alertsCollapsed);
  list.innerHTML = rows.map(m => {
    const full = `${new Date(m.sent_at).toLocaleString("vi-VN")} · ${m.thread_name} · ${m.sender_name}: ${m.content || ""}`;
    const kind = m.is_mention ? "TAG BẠN" : (m.thread_type === "user" ? "TIN RIÊNG" : "TIN");
    return `<div class="schedule-row alert-row"><span class="status">${kind}</span> ${escapeHtml(full)}</div>`;
  }).join("") || "Không có tin khớp bộ lọc.";
}

async function loadAlerts() {
  try {
    if (!contacts.length) await loadContacts().catch(() => {});
    const { params, senderName } = alertFilterParams();
    const rows = await api(`/api/alerts?${params}`);
    let filtered = (rows || []).filter(m => !isTrivialAlertContent(m.content));
    if (senderName && !params.get("senderId")) {
      const qn = normalizeSearch(senderName);
      filtered = filtered.filter(m => normalizeSearch(m.sender_name).includes(qn));
    }
    alertsCache = filtered;
    const names = [...new Set(filtered.map(m => m.sender_name).filter(Boolean))].slice(0, 80);
    const dl = $("#alertSenderList");
    if (dl) dl.innerHTML = names.map(n => `<option value="${escapeHtml(n)}"></option>`).join("");
    renderAlerts(alertsCache);
  } catch (e) {
    $("#alertList").textContent = e.message;
  }
}

async function loadAlertRules() {
  const box = $("#alertRuleList");
  if (!box) return;
  try {
    const rules = await api("/api/alert-rules");
    box.innerHTML = rules.map(r => {
      const mode = r.match_any ? "tag hoặc từ khóa" : (r.match_mention ? "chỉ khi tag mình" : "theo từ khóa");
      return `<div class="schedule-row"><b>${escapeHtml(r.name)}</b> · ${escapeHtml(r.keywords || "(không từ khóa)")} · ${mode} · ${r.priority === "high" ? "ưu tiên cao" : "thường"} · ${r.notify_bot ? "đẩy Bot" : "không Bot"} · ${r.group_id === "*" ? "mọi nhóm" : escapeHtml(r.group_id)} <button class="secondary delete-alert-rule" data-id="${r.id}">Xóa</button></div>`;
    }).join("") || "Chưa có quy tắc. Thêm từ khóa như “gấp, deadline” để nhận cảnh báo.";
    document.querySelectorAll(".delete-alert-rule").forEach(btn => {
      btn.onclick = async () => {
        if (!requireSecondClick(btn, "Bấm lại để xóa quy tắc.")) return;
        try { await api(`/api/alert-rules/${btn.dataset.id}`, { method: "DELETE" }); await loadAlertRules(); showNotice("Đã xóa quy tắc.", "success"); }
        catch (e) { showNotice(e.message, "error"); }
      };
    });
  } catch (e) { box.textContent = e.message; }
}

async function loadDashboard() {
  if (!$("#dashboard")) return;
  try {
    const now = Date.now();
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const [alerts, jobs, aiCfg, botCfg] = await Promise.all([
      api(`/api/alerts?from=${now - 86400000}&to=${now}&limit=80`),
      api("/api/schedules"),
      api("/api/ai-config"),
      api("/api/bot")
    ]);
    const mentions = alerts || [];

    const recent = mentions.slice(0, 6).map(m => {
      const t = new Date(m.sent_at).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
      return `<div class="row-item"><b>${escapeHtml(m.thread_name || "Nhóm")}</b><small>${escapeHtml((m.content || "").slice(0, 70))}</small><time>${t}</time></div>`;
    }).join("") || `<div class="row-item empty">Chưa có hoạt động gần đây.</div>`;
    if ($("#dashRecentList")) $("#dashRecentList").innerHTML = recent;

    const attention = mentions.slice(0, 6).map(m => {
      const t = new Date(m.sent_at).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
      const tag = m.is_mention ? "ĐỀ CẬP BẠN" : "NHẮN RIÊNG";
      return `<div class="row-item"><b>${escapeHtml(m.sender_name || "Người dùng")} <span class="tag-inline">${tag}</span></b><small>${escapeHtml((m.content || "").slice(0, 72))}</small><time>${t}</time></div>`;
    }).join("") || `<div class="row-item empty">Không có tin cần chú ý.</div>`;
    if ($("#dashAttentionList")) $("#dashAttentionList").innerHTML = attention;

    const pending = (jobs || []).filter(j => j.status === "pending").sort((a, b) => a.run_at - b.run_at).slice(0, 5);
    const nextSchedules = pending.map(j => {
      const when = new Date(j.run_at).toLocaleString("vi-VN");
      const kind = j.target_type === "user" ? "Cá nhân" : "Nhóm";
      return `<div class="compact-row"><div><strong>${kind}</strong><span>${when}</span></div></div>`;
    }).join("") || `<div class="compact-row"><div><strong>Chưa có lịch</strong><span>Tạo ở tab Giao việc & hẹn giờ</span></div></div>`;
    if ($("#dashScheduleList")) $("#dashScheduleList").innerHTML = nextSchedules;

    const reportRows = groups.filter(g => g.enabled).slice(0, 5).map(g => {
      return `<div class="compact-row"><div><strong>${escapeHtml(g.name)}</strong><span>${g.member_count || 0} thành viên</span></div></div>`;
    }).join("") || `<div class="compact-row"><div><strong>Chưa có nhóm theo dõi</strong><span>Hãy đồng bộ và bật nhóm</span></div></div>`;
    if ($("#dashReportList")) $("#dashReportList").innerHTML = reportRows;

    const badge = (text, kind) => `<span class="conn-badge ${kind}">${escapeHtml(text)}</span>`;
    const aiLabel = aiCfg?.providerLabel || aiProviderLabel(aiCfg?.provider) || "AI";
    const connected = Boolean(aiCfg?.connected);
    const usable = Boolean(aiCfg?.usable ?? (connected && aiCfg?.enabled));
    const aiConnKind = usable ? "ok" : (connected ? "warn" : "bad");
    const aiConnText = usable ? "Sẵn sàng" : (connected ? "Đã kết nối" : "Chưa kết nối");
    if ($("#dashAiStatus")) {
      $("#dashAiStatus").innerHTML = [
        badge(aiLabel, "muted"),
        badge(aiConnText, aiConnKind),
        badge(aiCfg?.enabled ? "Đang bật" : "Đang tắt", aiCfg?.enabled ? "info" : "muted")
      ].join("");
    }

    const botReady = Boolean(botCfg?.configured && botCfg?.usable !== false && !botCfg?.locked);
    const botReadyKind = botReady ? "ok" : (botCfg?.configured || botCfg?.chatId ? "warn" : "bad");
    const botName = botCfg?.botName || "Zalo Bot";
    if ($("#dashBotStatus")) {
      $("#dashBotStatus").innerHTML = [
        badge(botName, "muted"),
        badge(botReady ? "Sẵn sàng" : (botCfg?.configured ? "Chưa dùng được" : "Chưa cấu hình"), botReadyKind),
        botCfg?.chatId ? badge("Có Chat ID", "info") : badge("Chưa có Chat ID", "warn")
      ].join("");
    }

    await loadMessageChart(chartMode);
  } catch (error) {
    console.error(error);
  }
}

let chartMode = "hour";
let chartBuckets = [];
let chartFrom = null;
let chartTo = null;
let chartFocusLabel = "";

function chartRangeLabel(bucket, mode) {
  if (!bucket) return "";
  if (mode === "hour") {
    const h = Number(bucket.key);
    return `${String(h).padStart(2, "0")}:00 - ${String(h + 1).padStart(2, "0")}:00`;
  }
  if (mode === "day") return `Ngày ${bucket.label}`;
  return `Tháng ${bucket.label}`;
}

function chartTitleForMode(mode, focusLabel = chartFocusLabel) {
  if (mode === "day") return focusLabel ? `Tin nhắn theo ngày (${focusLabel})` : "Tin nhắn theo ngày (30 ngày)";
  if (mode === "month") return "Tin nhắn theo tháng (12 tháng)";
  return focusLabel ? `Tin nhắn theo giờ (${focusLabel})` : "Tin nhắn theo giờ (hôm nay)";
}

function avgUnitForMode(mode) {
  if (mode === "day") return "tin/ngày";
  if (mode === "month") return "tin/tháng";
  return "tin/giờ";
}

function barHint(mode) {
  if (mode === "month") return " · nhấp để xem theo ngày";
  if (mode === "day") return " · nhấp để xem theo giờ";
  return " · nhấp để xem danh sách tin";
}

async function loadChartMessages(bucket) {
  const panel = $("#dashChartMessages");
  const list = $("#dashChartMsgList");
  const title = $("#dashChartMsgTitle");
  if (!panel || !list || !bucket) return;
  panel.classList.remove("hidden");
  title.textContent = `${chartRangeLabel(bucket, chartMode)} · ${bucket.count} tin`;
  list.innerHTML = `<div class="row-item empty">Đang tải…</div>`;
  try {
    const rows = await api(`/api/messages/search?from=${bucket.from}&to=${bucket.to}&limit=200`);
    list.innerHTML = (rows || []).map(m => {
      const t = new Date(m.sent_at).toLocaleString("vi-VN");
      return `<div class="row-item"><b>${escapeHtml(m.thread_name || "Nhóm")} · ${escapeHtml(m.sender_name || "")}</b><small>${escapeHtml((m.content || "").slice(0, 140))}</small><time>${t}</time></div>`;
    }).join("") || `<div class="row-item empty">Không có tin trong khoảng này.</div>`;
  } catch (e) {
    list.innerHTML = `<div class="row-item empty">${escapeHtml(e.message)}</div>`;
  }
}

function renderMessageChart(stats) {
  const buckets = stats?.buckets || [];
  chartBuckets = buckets;
  const max = Math.max(1, ...buckets.map(b => b.count), 0);
  const bars = buckets.map((b, idx) => {
    const ph = Math.round((b.count / max) * 100);
    const empty = b.count <= 0;
    return `<div class="bar-wrap clickable${empty ? " is-empty" : ""}" data-idx="${idx}" title="${escapeHtml(chartRangeLabel(b, chartMode))} · ${b.count} tin${barHint(chartMode)}"><i style="height:${Math.max(ph, b.count ? 4 : 0)}%"></i><span>${escapeHtml(b.label)}</span></div>`;
  }).join("");
  if ($("#dashHourChart")) $("#dashHourChart").innerHTML = bars || `<div class="row-item empty">Chưa có dữ liệu.</div>`;
  document.querySelectorAll("#dashHourChart .bar-wrap.clickable:not(.is-empty)").forEach(el => {
    el.onclick = () => {
      const bucket = chartBuckets[Number(el.dataset.idx)];
      if (!bucket) return;
      document.querySelectorAll("#dashHourChart .bar-wrap").forEach(x => x.classList.remove("active"));
      el.classList.add("active");
      if (chartMode === "month") {
        loadMessageChart("day", { from: bucket.from, to: bucket.to, label: bucket.label });
        return;
      }
      if (chartMode === "day") {
        loadMessageChart("hour", { from: bucket.from, to: bucket.to, label: bucket.label });
        return;
      }
      loadChartMessages(bucket);
    };
  });

  const peak = buckets.reduce((best, cur) => cur.count > best.count ? cur : best, { count: -1, label: "—" });
  if ($("#dashPeakHour")) $("#dashPeakHour").textContent = peak.count > 0 ? chartRangeLabel(peak, chartMode) : "—";
  const total = Number(stats?.total || buckets.reduce((s, b) => s + b.count, 0));
  const denom = Math.max(buckets.length, 1);
  if ($("#dashTotalToday")) $("#dashTotalToday").textContent = `${total} tin`;
  if ($("#dashAvgPerHour")) $("#dashAvgPerHour").textContent = `${(total / denom).toFixed(1)} ${avgUnitForMode(chartMode)}`;
  if ($("#dashChartTitle")) $("#dashChartTitle").textContent = chartTitleForMode(chartMode);
  if (chartMode === "hour" && !chartFocusLabel && $("#messageCount")) $("#messageCount").textContent = String(total);
}

async function loadMessageChart(mode = chartMode, range) {
  chartMode = mode;
  if (range === null) {
    chartFrom = null;
    chartTo = null;
    chartFocusLabel = "";
  } else if (range) {
    chartFrom = Number(range.from);
    chartTo = Number(range.to);
    chartFocusLabel = range.label || "";
  }
  document.querySelectorAll(".chart-mode").forEach(btn => btn.classList.toggle("active", btn.dataset.mode === mode));
  $("#dashChartMessages")?.classList.add("hidden");
  try {
    const qs = new URLSearchParams({ granularity: mode });
    if (chartFrom != null) qs.set("from", String(chartFrom));
    if (chartTo != null) qs.set("to", String(chartTo));
    const stats = await api(`/api/messages/stats?${qs}`);
    renderMessageChart(stats);
  } catch (e) {
    if ($("#dashHourChart")) $("#dashHourChart").innerHTML = `<div class="row-item empty">${escapeHtml(e.message)}</div>`;
  }
}

function savedStatus(card, configured, title, details) {
  let box = card.querySelector(".saved-status");
  const anchor = card.querySelector(".settings-card-top") || card.querySelector("h2");
  if (!box) { box = document.createElement("div"); box.className = "saved-status"; anchor.after(box); }
  box.className = `saved-status ${configured ? "configured" : "not-configured"}`;
  box.innerHTML = `<span class="status-dot"></span><div><strong>${title}</strong><small>${details}</small></div>`;
}
let aiSettingsEditing = false;
let botSettingsEditing = false;
let botSettingsCollapsed = null;
let botTestSucceeded = false;

function applyBotSettingsView(configured) {
  const card = $("#botSettingsCard");
  const body = $("#botSettingsBody");
  const editBtn = $("#editBotSettings");
  const toggleBtn = $("#toggleBotSettings");
  if (!card || !body) return;
  const collapse = botSettingsCollapsed != null
    ? botSettingsCollapsed
    : Boolean(configured && !botSettingsEditing);
  body.classList.toggle("collapsed", collapse);
  card.classList.toggle("settings-collapsed", collapse);
  if (editBtn) editBtn.classList.toggle("hidden", !configured || botSettingsEditing || !collapse);
  if (toggleBtn) toggleBtn.textContent = collapse ? "Mở rộng" : "Thu gọn";
}

function setSettingsCardView(card, body, editBtn, configured, editing) {
  if (!card || !body) return;
  const collapse = Boolean(configured && !editing);
  body.classList.toggle("collapsed", collapse);
  card.classList.toggle("settings-collapsed", collapse);
  if (editBtn) editBtn.classList.toggle("hidden", !configured || editing);
}

function updateBotStepButtons(b = {}) {
  const saveBtn = $("#saveBot");
  const discoverBtn = $("#discoverBot");
  const testBtn = $("#testBot");
  if (!saveBtn || !discoverBtn || !testBtn) return;

  const hasToken = Boolean(b.configured || b.token);
  const chatId = String($("#botChatId")?.value || b.chatId || "").trim();
  const hasChatId = Boolean(chatId);

  for (const btn of [saveBtn, discoverBtn, testBtn]) {
    btn.classList.remove("bot-step-active", "bot-step-done", "bot-step-wait");
  }

  if (botTestSucceeded && hasToken && hasChatId) {
    saveBtn.classList.add("bot-step-done");
    discoverBtn.classList.add("bot-step-done");
    testBtn.classList.add("bot-step-done");
    return;
  }

  if (!hasToken) {
    saveBtn.classList.add("bot-step-active");
    discoverBtn.classList.add("bot-step-wait");
    testBtn.classList.add("bot-step-wait");
    return;
  }

  if (!hasChatId) {
    saveBtn.classList.add("bot-step-done");
    discoverBtn.classList.add("bot-step-active");
    testBtn.classList.add("bot-step-wait");
    return;
  }

  saveBtn.classList.add("bot-step-done");
  discoverBtn.classList.add("bot-step-done");
  testBtn.classList.add("bot-step-active");
}
function expandAiSettings() {
  aiSettingsEditing = true;
  setSettingsCardView($("#aiSettingsCard"), $("#aiSettingsBody"), $("#editAiSettings"), true, true);
}
function expandBotSettings() {
  botSettingsEditing = true;
  botSettingsCollapsed = false;
  applyBotSettingsView(true);
}

function collapseBotSettings(configured = true) {
  botSettingsEditing = false;
  botSettingsCollapsed = true;
  applyBotSettingsView(configured);
}

function toggleBotSettingsPanel() {
  const body = $("#botSettingsBody");
  if (!body) return;
  if (body.classList.contains("collapsed")) expandBotSettings();
  else collapseBotSettings(true);
}
const savedTime = value => value ? new Date(value).toLocaleString("vi-VN") : "Đã lưu trước bản cập nhật trạng thái";
async function loadBot(){
  const b=await api("/api/bot"), card=$("#botNotice").closest(".card");
  if (b.locked) {
    const kept = b.configured || b.chatId || b.token;
    savedStatus(card, false, kept ? "Zalo Bot đã lưu — chờ đăng nhập Zalo" : "Zalo Bot chưa khả dụng",
      kept
        ? `${b.botName||"Zalo Bot"}${b.token?` · Token ${b.token}`:""}${b.chatId?` · Chat ID ${b.chatId}`:""} · Đăng nhập QR để dùng lại`
        : (b.lockReason || "Cần đăng nhập Zalo bằng QR trước."));
    $("#botNotice").textContent = "Cấu hình Bot vẫn được giữ. Đăng nhập Zalo QR để tiếp tục dùng.";
    if (b.chatId) $("#botChatId").value = b.chatId;
    applyBotSettingsView(Boolean(kept));
    updateBotStepButtons(b);
    return;
  }
  savedStatus(card,b.configured,b.configured?"Zalo Bot đã cấu hình":"Zalo Bot chưa cấu hình",b.configured?`${b.botName||"Zalo Bot"} · Token ${b.token}${b.chatId?` · Chat ID ${b.chatId}`:" · Chưa có Chat ID"} · ${savedTime(b.savedAt)}`:"Nhập Bot Token và Chat ID, sau đó bấm Kiểm tra và lưu token.");
  $("#botNotice").textContent=b.configured?"Cấu hình đang được lưu và sẵn sàng sử dụng.":""; if(b.chatId) $("#botChatId").value=b.chatId;
  if (!b.configured) botTestSucceeded = false;
  applyBotSettingsView(Boolean(b.configured));
  updateBotStepButtons(b);
}
async function loadDataLocation() {
  const notice = $("#dataLocationNotice");
  const hint = $("#dataLocationHint");
  const input = $("#dataLocationPath");
  if (!input) return;
  try {
    const info = await api("/api/data-location");
    input.value = info.path || "";
    hint.textContent = info.isDefault
      ? `Đang dùng thư mục mặc định của app.${info.writable === false ? " (Không ghi được — kiểm tra quyền thư mục.)" : ""}`
      : `Đang dùng thư mục tùy chọn. Mặc định: ${info.defaultPath}`;
    if (notice) notice.textContent = "";
  } catch (e) {
    if (hint) hint.textContent = e.message;
    if (notice) notice.textContent = e.message;
  }
}
async function applyDataLocation({ useDefault = false } = {}) {
  const notice = $("#dataLocationNotice");
  const button = $("#saveDataLocation");
  const resetBtn = $("#resetDataLocation");
  try {
    if (button) button.disabled = true;
    if (resetBtn) resetBtn.disabled = true;
    if (notice) notice.textContent = "Đang chuyển dữ liệu…";
    const body = useDefault
      ? { useDefault: true }
      : { path: $("#dataLocationPath").value };
    const info = await api("/api/data-location", { method: "POST", body: JSON.stringify(body) });
    $("#dataLocationPath").value = info.path || "";
    if (notice) notice.textContent = info.message || "Đã cập nhật nơi lưu dữ liệu.";
    showNotice(info.message || "Đã cập nhật nơi lưu dữ liệu.", "success");
    await loadDataLocation();
    if (zaloOnline) {
      await Promise.all([
        loadGroups().catch(console.error),
        loadSchedules().catch(console.error),
        loadDashboard().catch(console.error)
      ]);
    }
  } catch (e) {
    if (notice) notice.textContent = e.message;
    showNotice(e.message, "error");
  } finally {
    if (button) button.disabled = false;
    if (resetBtn) resetBtn.disabled = false;
  }
}
async function saveAiConfig({ enabled } = {}) {
  syncAiHiddenFromVisible();
  await api("/api/ai-config", {
    method: "POST",
    body: JSON.stringify({
      enabled: enabled ?? $("#aiEnabled").checked,
      provider: getAiProvider(),
      baseUrl: $("#aiBaseUrl")?.value || "",
      model: $("#aiModel")?.value || "",
      apiKey: $("#aiApiKey")?.value || "",
      prompt: $("#aiPrompt")?.value || ""
    })
  });
  if ($("#aiApiKey")) $("#aiApiKey").value = "";
  if ($("#aiApiKeyVisible")) $("#aiApiKeyVisible").value = "";
  aiSettingsEditing = false;
  await loadAi();
  await loadDashboard().catch(console.error);
}

async function pollCliLoginAfterBrowser({ timeoutMs = 90000 } = {}) {
  const provider = getAiProvider();
  if (!isCliProviderId(provider)) return false;
  const started = Date.now();
  $("#aiNotice").textContent = "Đang chờ bạn hoàn tất đăng nhập trên trình duyệt…";
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const status = await api(`/api/ai-cli/login-status?provider=${encodeURIComponent(provider)}`);
    if (status?.loggedIn) {
      $("#aiEnabled").checked = true;
      $("#aiNotice").textContent = "Đã nhận đăng nhập. Đang lưu cấu hình…";
      await saveAiConfig({ enabled: true });
      await refreshAiCliStatus();
      await updateAiStatusCard({ provider, enabled: true, configured: true, model: $("#aiModel").value });
      showNotice("Đã kết nối và lưu AI.", "success");
      return true;
    }
    const secs = Math.round((Date.now() - started) / 1000);
    $("#aiNotice").textContent = `Đang chờ đăng nhập trên trình duyệt… (${secs}s)`;
  }
  $("#aiNotice").textContent = "Chưa thấy đăng nhập. Hoàn tất trên trình duyệt rồi bấm Quét lại.";
  return false;
}

async function loadAi(){
  const c=await api("/api/ai-config"), card=$("#aiNotice").closest(".card");
  $("#aiEnabled").checked = c.enabled;
  if (c.provider) setAiProvider(c.provider, { refresh: false });
  if (c.baseUrl != null && $("#aiBaseUrl")) $("#aiBaseUrl").value = c.baseUrl;
  if (c.model != null && $("#aiModel")) $("#aiModel").value = c.model;
  if ($("#aiPrompt") && c.prompt != null) $("#aiPrompt").value = c.prompt;
  syncAiVisibleFieldsFromHidden();
  if (c.maskedKey && $("#aiApiKeyHint")) {
    $("#aiApiKeyHint").textContent = `Đã lưu key (${c.maskedKey}). Để trống ô key nếu giữ nguyên.`;
  }
  toggleAiMode();
  if (c.locked) {
    const kept = c.hasSavedConfig || c.maskedKey || c.enabled || isCliProviderId(c.provider) || isCliProxyProvider(c.provider) || isApiProviderId(c.provider);
    savedStatus(card, false, kept ? "AI đã lưu — chờ đăng nhập Zalo" : "AI chưa khả dụng",
      kept
        ? `${c.providerLabel || aiProviderLabel(c.provider)} · Đăng nhập QR để dùng lại`
        : (c.lockReason || "Cần đăng nhập Zalo bằng QR trước."));
    $("#aiNotice").textContent = "Cấu hình AI vẫn được giữ. Đăng nhập Zalo QR để tiếp tục dùng.";
    if ($("#aiCliStatus")) $("#aiCliStatus").textContent = "Chưa đăng nhập Zalo — cấu hình vẫn được lưu.";
    if ($("#aiCliProxyStatus")) $("#aiCliProxyStatus").textContent = "Chưa đăng nhập Zalo — cấu hình vẫn được lưu.";
    setSettingsCardView($("#aiSettingsCard"), $("#aiSettingsBody"), $("#editAiSettings"), Boolean(kept), aiSettingsEditing);
    return;
  }
  if (isApiProviderId(c.provider) || saasMode) {
    await updateAiStatusCard(c);
    return;
  }
  if (isCliProxyProvider(c.provider)) await refreshCliProxyStatus();
  else await refreshAiCliStatus();
  await updateAiStatusCard(c);
}
async function updateAiStatusCard(c) {
  const card=$("#aiNotice").closest(".card");
  const provider = getAiProvider() || c.provider;
  const providerLabel = c.providerLabel || aiProviderLabel(provider);
  const cli = isCliProviderId(provider);
  const cpa = isCliProxyProvider(provider);
  if (cli) {
    const selected = await fetchSelectedCliStatus(provider);
    const connected = Boolean(selected?.ready || selected?.loggedIn);
    const usable = Boolean(connected && $("#aiEnabled").checked);
    const title = usable
      ? "AI sẵn sàng"
      : (connected ? "AI đã kết nối" : (selected?.installed ? "AI CLI chưa đăng nhập" : "AI CLI chưa cài"));
    const details = selected
      ? `${selected.name} · ${selected.installed ? (selected.loggedIn ? "đã đăng nhập" : "chưa đăng nhập") : "chưa cài"} · ${selected.detail || ""}`
      : "Chọn ChatGPT/Codex hoặc Claude rồi bấm Đăng nhập trên trình duyệt.";
    savedStatus(card, connected, title, details);
    $("#aiNotice").textContent = usable
      ? "Đã kết nối và bật AI. Bấm Lưu nếu vừa đổi cấu hình."
      : (connected
        ? "Đã đăng nhập CLI. Bật AI và bấm Lưu cấu hình để dùng cho báo cáo."
        : (selected?.installed
          ? (selected?.loginHint || "Hãy đăng nhập trước khi lưu.")
          : "Chưa có CLI. Bấm Đăng nhập — app sẽ tự cài giúp."));
    const loginBtn = $("#loginAiCli");
    const installBtn = $("#installAiCli");
    const updateBtn = $("#updateAiCli");
    const compatBtn = $("#checkAiCliCompat");
    if (loginBtn) {
      loginBtn.disabled = selected ? (!selected.canBrowserLogin && selected.installed) : false;
      loginBtn.textContent = "Đăng nhập trên trình duyệt";
    }
    if (installBtn) {
      installBtn.classList.toggle("hidden", Boolean(selected?.installed));
      installBtn.disabled = selected ? !selected.canAutoInstall : false;
    }
    if (updateBtn) {
      updateBtn.classList.toggle("hidden", !selected?.installed);
      updateBtn.disabled = !selected?.installed;
    }
    if (compatBtn) compatBtn.disabled = false;
    if (!connected) aiSettingsEditing = false;
    setSettingsCardView($("#aiSettingsCard"), $("#aiSettingsBody"), $("#editAiSettings"), connected, aiSettingsEditing);
  } else if (cpa) {
    const status = c.cliProxyApi || await refreshCliProxyStatus();
    const connected = Boolean(status?.ready || c.connected);
    const usable = Boolean(connected && $("#aiEnabled").checked);
    savedStatus(card, connected,
      usable ? "AI sẵn sàng" : (connected ? "AI brain đã kết nối" : "Chưa kết nối AI brain"),
      `${providerLabel} · ${status?.message || c.statusText || ""}`);
    $("#aiNotice").textContent = usable
      ? "Đã kết nối qua AI brain."
      : (status?.running
        ? "AI brain đang chạy — đăng nhập tài khoản rồi bấm Kết nối & lưu."
        : "Bấm Khởi động, đăng nhập tài khoản, rồi Kết nối.");
    if (!connected) aiSettingsEditing = false;
    setSettingsCardView($("#aiSettingsCard"), $("#aiSettingsBody"), $("#editAiSettings"), connected, aiSettingsEditing);
  } else if (isApiProviderId(provider) || saasMode) {
    const connected = Boolean(c.connected || c.maskedKey || c.configured);
    const usable = Boolean(connected && $("#aiEnabled").checked);
    savedStatus(card, connected,
      usable ? "AI sẵn sàng" : (connected ? "Đã lưu API key" : "Chưa cấu hình AI"),
      `${providerLabel}${c.maskedKey ? ` · ${c.maskedKey}` : ""} · ${c.model || $("#aiModel")?.value || ""}`);
    $("#aiNotice").textContent = usable
      ? "AI API đã sẵn sàng cho báo cáo."
      : (connected ? "Bật AI và bấm Lưu nếu cần." : "Chọn nhà cung cấp, nhập API key rồi Lưu.");
    setSettingsCardView($("#aiSettingsCard"), $("#aiSettingsBody"), $("#editAiSettings"), connected, aiSettingsEditing || !connected);
  } else {
    savedStatus(card, false, "AI chưa cấu hình", "Chọn ChatGPT/Codex, Claude hoặc AI brain.");
    $("#aiNotice").textContent = "";
    setSettingsCardView($("#aiSettingsCard"), $("#aiSettingsBody"), $("#editAiSettings"), false, true);
  }
}
function toggleAiMode() {
  const provider = getAiProvider();
  const cli = isCliProviderId(provider);
  const cpa = isCliProxyProvider(provider);
  const apiMode = saasMode || isApiProviderId(provider);
  $("#aiAccountConnectBlock")?.classList.toggle("hidden", saasMode);
  $("#aiApiConnectBlock")?.classList.toggle("hidden", !saasMode && !apiMode);
  $("#aiCliFields")?.classList.toggle("hidden", !cli || saasMode);
  $("#aiCliProxyFields")?.classList.toggle("hidden", !cpa || saasMode);
  if (saasMode && $("#aiLeadText")) {
    $("#aiLeadText").innerHTML = "Chọn nhà cung cấp AI và nhập <b>API key</b> — dùng trên web, không cần cài CLI.";
  }
}
async function fetchSelectedCliStatus(provider = getAiProvider()) {
  if (!provider || !isCliProviderId(provider)) return null;
  const data = await api(`/api/ai-cli?provider=${encodeURIComponent(provider)}`);
  return (data.detected || []).find(tool => tool.id === provider) || null;
}
async function refreshAiCliStatus() {
  const box = $("#aiCliStatus");
  if (!box) return null;
  const selectedId = getAiProvider();
  box.textContent = "Đang quét trạng thái đăng nhập…";
  try {
    const data = await api("/api/ai-cli");
    box.innerHTML = (data.detected||[]).map(tool => {
      const badge = tool.ready ? "sẵn sàng" : (!tool.installed ? "chưa cài" : "chưa login");
      const cls = tool.ready ? "ok" : (!tool.installed ? "bad" : "warn");
      const current = tool.id === selectedId ? " · đang chọn" : "";
      const detail = tool.installed
        ? `${escapeHtml(tool.version || "")}${tool.detail ? ` · ${escapeHtml(tool.detail)}` : ""}`
        : escapeHtml(tool.installHint || tool.error || "");
      return `<div class="cli-row"><div><b>${escapeHtml(tool.name)}</b>${current}<small>${detail}</small></div><span class="cli-badge ${cls}">${badge}</span></div>`;
    }).join("") || "Không có CLI nào được hỗ trợ.";
    return (data.detected||[]).find(tool => tool.id === selectedId) || null;
  } catch (error) {
    box.textContent = error.message;
    return null;
  }
}
function updateCliProxySteps(status = {}) {
  const running = Boolean(status.running);
  const hasAccount = Boolean(status.loggedIn || (status.models || []).length);
  const ready = Boolean(status.ready);
  // Bước 1: chưa chạy → chỉ Khởi động
  // Bước 2: đã chạy, chưa có tài khoản → Đăng nhập
  // Bước 3: đã có tài khoản → Kết nối & lưu
  const step = !running ? 1 : (!hasAccount ? 2 : 3);
  $("#aiCliProxyStepStart")?.classList.toggle("hidden", step !== 1);
  $("#aiCliProxyStepLogin")?.classList.toggle("hidden", step !== 2);
  $("#aiCliProxyStepConnect")?.classList.toggle("hidden", step !== 3);
  const hint = $("#aiCliProxyStepHint");
  if (hint) {
    if (step === 1) hint.innerHTML = "Bước 1/3 — Bấm <b>Khởi động</b> để chạy AI brain.";
    else if (step === 2) hint.innerHTML = "Bước 2/3 — Chọn <b>Đăng nhập Google / ChatGPT / Claude</b>, hoàn tất trên trình duyệt, rồi Quét lại.";
    else if (ready) hint.innerHTML = "Đã sẵn sàng — có thể <b>Kết nối &amp; lưu</b> lại hoặc đổi tài khoản bằng Quét lại.";
    else hint.innerHTML = "Bước 3/3 — Bấm <b>Kết nối &amp; lưu</b> để dùng AI brain cho báo cáo.";
  }
}

async function refreshCliProxyStatus() {
  const box = $("#aiCliProxyStatus");
  try {
    const status = await api("/api/cli-proxy-api/status");
    if (box) {
      const badge = status.ready
        ? "sẵn sàng"
        : (!status.installed ? "thiếu binary" : (!status.running ? "chưa chạy" : "chờ đăng nhập"));
      const cls = status.ready ? "ok" : ((!status.installed || !status.running) ? "bad" : "warn");
      const models = (status.models || []).slice(0, 4).join(", ");
      const title = status.bundled ? "AI brain · có sẵn trong app" : "AI brain";
      box.innerHTML = `<div class="cli-row"><div><b>${title}</b><small>${escapeHtml(status.message || "")}${models ? ` · ${escapeHtml(models)}` : ""}</small></div><span class="cli-badge ${cls}">${badge}</span></div>`;
    }
    updateCliProxySteps(status);
    const installBtn = $("#installCliProxy");
    if (installBtn) {
      installBtn.classList.toggle("hidden", Boolean(status.bundled || status.installed));
      installBtn.textContent = "Tải AI brain";
    }
    return status;
  } catch (error) {
    if (box) box.textContent = error.message;
    updateCliProxySteps({ running: false, loggedIn: false, models: [] });
    return { ready: false, running: false, installed: false, message: error.message };
  }
}
async function loadDigestSchedules() {
  const rows = await api("/api/digest-schedules");
  const labelChannel = raw => String(raw || "").split(",").map(s => s.trim()).filter(Boolean).map(ch => ({
    web: "App",
    csv: "CSV (thư mục data)",
    bot: "Zalo Bot"
  }[ch] || ch)).join(" · ") || "Chưa chọn kênh";
  $("#digestScheduleList").innerHTML = rows.map(x => `<div class="schedule-row">${escapeHtml(x.time_of_day)} hằng ngày · ${escapeHtml(x.group_id === "*" ? "Tất cả nhóm" : groups.find(g => g.id === x.group_id)?.name || x.group_id)} · ${escapeHtml(labelChannel(x.channels))} <button class="secondary delete-digest-schedule" data-id="${x.id}">Xóa lịch</button></div>`).join("") || "Chưa có lịch tổng hợp.";
  document.querySelectorAll(".delete-digest-schedule").forEach(button => button.onclick = async () => {
    if (!requireSecondClick(button, "Bấm lại nút xóa trong 5 giây để xác nhận.")) return;
    try {
      await api(`/api/digest-schedules/${button.dataset.id}`, { method: "DELETE" });
      showNotice("Đã xóa lịch tổng hợp.", "success");
      await loadDigestSchedules();
    } catch (error) {
      showNotice(error.message, "error");
    }
  });
}
function selectedDigestChannels() {
  const channels = [];
  if ($("#digestChannelWeb")?.checked) channels.push("web");
  if ($("#digestChannelCsv")?.checked) channels.push("csv");
  if ($("#digestChannelBot")?.checked) channels.push("bot");
  return channels;
}

async function startLogin() {
  await api("/api/login/qr", { method: "POST" });
  $("#qrArea").textContent = "Đang tạo QR…";
}
function bindLoginBtn() {
  const btn = $("#loginBtn");
  if (btn) btn.onclick = startLogin;
}
bindLoginBtn();
$("#logoutBtn").onclick = async () => {
  const button = $("#logoutBtn");
  if (!requireSecondClick(button, "Bấm lại để xác nhận đăng xuất. Phiên Zalo trên máy này sẽ bị xóa.")) return;
  try {
    await api("/api/logout", { method: "POST" });
    clearZaloUi("Đã đăng xuất Zalo. Cấu hình AI/Bot vẫn được giữ — đăng nhập QR lại để tiếp tục dùng.");
    $("#qrArea").innerHTML = `<button id="loginBtn">Tạo mã QR</button>`;
    bindLoginBtn();
    await status();
    if (!$("#settings").classList.contains("hidden")) {
      await Promise.all([loadAi().catch(console.error), loadBot().catch(console.error)]);
    }
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    button.dataset.confirming = "false";
    button.textContent = button.dataset.originalText || "Đăng xuất";
    button.classList.remove("confirming");
  }
};
$("#sync").onclick = async () => {
  $("#sync").textContent = "Đang đồng bộ…";
  try {
    await api("/api/groups/sync", { method: "POST" });
    await api("/api/contacts/sync", { method: "POST" }).catch(() => {});
    await loadGroups();
    await Promise.all([loadSchedules().catch(console.error), loadDashboard().catch(console.error)]);
    showNotice("Đã đồng bộ nhóm/danh bạ theo tài khoản đang đăng nhập (đã bỏ mục không thuộc tài khoản này).", "success");
  } catch (e) {
    showNotice(e.message, "error");
  } finally {
    $("#sync").textContent = "Đồng bộ nhóm";
  }
};
$("#scheduleGroup").onchange = loadMembers;
$("#groupSearch").oninput = async () => { renderScheduleGroups(); await loadMembers(); };
$("#contactSearch").oninput = renderContacts;
$("#targetType").onchange = async () => {
  const personal = $("#targetType").value === "user";
  $("#groupTargetLabel").classList.toggle("hidden", personal);
  $("#memberTargetLabel").classList.toggle("hidden", personal);
  $("#userTargetLabel").classList.toggle("hidden", !personal);
  if (personal && !contacts.length) await loadContacts();
};
function renderDailyTimes() {
  $("#dailyTimeList").innerHTML = dailyTimes.map((t, i) => `<span class="time-chip">${t}<button type="button" data-time-index="${i}" aria-label="Xóa">×</button></span>`).join("");
  document.querySelectorAll("[data-time-index]").forEach(x => x.onclick = () => { dailyTimes.splice(Number(x.dataset.timeIndex), 1); renderDailyTimes(); });
}
$("#recurrence").onchange = () => {
  const daily = $("#recurrence").value === "daily";
  $("#onceTimeLabel").classList.toggle("hidden", daily);
  $("#dailyTimes").classList.toggle("hidden", !daily);
};
$("#addDailyTime").onclick = () => { const t = $("#dailyTime").value; if (t && !dailyTimes.includes(t)) dailyTimes.push(t); dailyTimes.sort(); renderDailyTimes(); };
$("#digestBtn").onclick = async () => {
  const groupId = $("#reportGroup").value, hours = Number($("#reportRange").value);
  if (!groupId) return showNotice("Chưa có nhóm để tạo báo cáo.", "error");
  $("#digestOutput").textContent = "Đang tổng hợp…";
  try { const d = await api(`/api/groups/${groupId}/digests`, { method: "POST", body: JSON.stringify({ from: Date.now() - hours * 3600000 }) }); $("#digestOutput").textContent = d.content; } catch(e) { $("#digestOutput").textContent = e.message; }
};
$("#scheduleBtn").onclick = async () => {
  const members = [...document.querySelectorAll("#memberList input:checked")].map(x => ({ id: x.value, name: x.dataset.name }));
  try {
    const targetType = $("#targetType").value;
    const targetId = targetType === "user" ? $("#scheduleContact").value : $("#scheduleGroup").value;
    if (!targetId) throw new Error("Hãy chọn người hoặc nhóm nhận");
    const recurrence = $("#recurrence").value;
    const runTimes = recurrence === "daily" ? dailyTimes.map(t => { const [h,m] = t.split(":").map(Number), d = new Date(); d.setHours(h,m,0,0); if (d.getTime() < Date.now()+5000) d.setDate(d.getDate()+1); return d.getTime(); }) : [new Date($("#runAt").value).getTime()];
    if (!runTimes.length) throw new Error("Hãy thêm ít nhất một giờ nhắc");
    const results = [];
    for (const runAt of runTimes) results.push(await api("/api/schedules", { method: "POST", body: JSON.stringify({ groupId: targetId, targetType, content: $("#scheduleContent").value, members: targetType === "group" ? members : [], runAt, recurrence }) }));
    $("#scheduleNotice").textContent = `Đã tạo ${results.length} lịch. Nội dung gửi: ${results[0].preview.msg}`; await loadSchedules();
  } catch(e) { $("#scheduleNotice").textContent = e.message; }
};
$("#refreshAlerts").onclick=loadAlerts;
document.querySelectorAll(".chart-mode").forEach(btn => {
  btn.onclick = () => loadMessageChart(btn.dataset.mode || "hour", null);
});
$("#closeChartMessages")?.addEventListener("click", () => {
  $("#dashChartMessages")?.classList.add("hidden");
  document.querySelectorAll("#dashHourChart .bar-wrap").forEach(x => x.classList.remove("active"));
});
$("#toggleAlertsCompact").onclick = () => {
  alertsCollapsed = !alertsCollapsed;
  $("#toggleAlertsCompact").textContent = alertsCollapsed ? "Mở danh sách" : "Thu gọn danh sách";
  $("#alertList")?.classList.toggle("collapsed", alertsCollapsed);
};
$("#exportAlerts").onclick=()=>{
  const { params } = alertFilterParams();
  const alertKind = params.get("kind") || "";
  params.delete("kind");
  params.set("kind", "alerts");
  if (alertKind) params.set("alertKind", alertKind);
  location.href=`/api/export.csv?${params}`;
};
$("#exportAlertsFull").onclick=()=>{
  const { params } = alertFilterParams();
  const alertKind = params.get("kind") || "";
  params.delete("kind");
  params.set("kind", "alerts");
  params.set("full", "1");
  if (alertKind) params.set("alertKind", alertKind);
  location.href=`/api/export.csv?${params}`;
};
$("#viewAssets").onclick=async()=>{ const box=$("#assetList"); try{ const list=await api("/api/assets"); if(!list.length){ box.innerHTML="<p>Chưa có ảnh/tệp nào được lưu. Ảnh/tệp sẽ được tải từ thời điểm bản cập nhật này trở đi.</p>"; return; } box.innerHTML=list.slice(0,50).map(a=>{ const rel="/api/assets/"+encodeURIComponent(a.name); const img=/^image\//.test(a.mime)?`<img src="${rel}" style="max-width:120px;max-height:90px" alt=""/>`:`<a href="${rel}" target="_blank">Tải tệp</a>`; return `<div class="alert-item"><b>${a.name}</b> · ${a.kind} · ${(a.size/1024).toFixed(1)}KB · ${new Date(a.created_at).toLocaleString("vi-VN")}<br>${img}</div>`; }).join("") + (list.length>50?"<p>… chỉ hiện 50 mục mới nhất</p>":""); }catch(e){ box.textContent=e.message; } };
$("#saveAlertRule")?.addEventListener("click", async () => {
  try {
    await api("/api/alert-rules", {
      method: "POST",
      body: JSON.stringify({
        name: $("#ruleName").value,
        keywords: $("#ruleKeywords").value,
        groupId: $("#ruleGroup").value || "*",
        priority: $("#rulePriority").value,
        matchMention: $("#ruleMention").checked,
        matchAny: $("#ruleMatchAny").checked,
        notifyBot: $("#ruleNotifyBot").checked
      })
    });
    $("#ruleName").value = "";
    $("#ruleKeywords").value = "";
    $("#ruleMention").checked = false;
    $("#ruleMatchAny").checked = false;
    $("#alertRuleNotice").textContent = "Đã thêm quy tắc.";
    await loadAlertRules();
    showNotice("Đã thêm quy tắc cảnh báo.", "success");
  } catch (e) {
    $("#alertRuleNotice").textContent = e.message;
    showNotice(e.message, "error");
  }
});
$("#saveBot").onclick=async()=>{try{await api("/api/bot",{method:"POST",body:JSON.stringify({token:$("#botToken").value,chatId:$("#botChatId").value})}); $("#botToken").value=""; botSettingsEditing=false; botSettingsCollapsed=null; await loadBot();}catch(e){$("#botNotice").textContent=e.message;}};
$("#browseDataLocation")?.addEventListener("click", async () => {
  const notice = $("#dataLocationNotice");
  const button = $("#browseDataLocation");
  try {
    if (button) button.disabled = true;
    if (notice) notice.textContent = "Đang mở hộp thoại chọn thư mục… (nếu không thấy, xem thanh taskbar / cửa sổ phía sau trình duyệt)";
    const result = await api("/api/data-location/browse", { method: "POST", body: "{}" });
    if (result.cancelled || !result.path) {
      if (notice) notice.textContent = "Đã hủy chọn thư mục. Bạn vẫn có thể dán đường dẫn rồi bấm Áp dụng.";
      return;
    }
    $("#dataLocationPath").value = result.path;
    if (notice) notice.textContent = "Đã chọn thư mục. Bấm Áp dụng để chuyển dữ liệu.";
  } catch (e) {
    if (notice) notice.textContent = e.message + " — Bạn có thể dán đường dẫn vào ô rồi bấm Áp dụng.";
    showNotice(e.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
});
$("#saveDataLocation")?.addEventListener("click", () => applyDataLocation());
$("#resetDataLocation")?.addEventListener("click", () => applyDataLocation({ useDefault: true }));
$("#discoverBot").onclick=async()=>{const button=$("#discoverBot"); try{button.disabled=true; $("#botNotice").textContent="Đang chờ tin nhắn mới… Hãy nhắn cho bot ngay bây giờ (tối đa 25 giây)."; const chats=await api("/api/bot/discover",{method:"POST"}); if(!chats.length) throw new Error("Chưa nhận được tin mới. Bấm tìm lại rồi nhắn đúng bot ngay khi trạng thái đang chờ."); $("#botChatId").value=chats[0].id; $("#botNotice").textContent=`Đã tìm thấy: ${chats.map(x=>`${x.name} (${x.id})`).join(", ")}`; updateBotStepButtons({ configured: true, chatId: chats[0].id });}catch(e){$("#botNotice").textContent=e.message;}finally{button.disabled=false;}};
$("#testBot").onclick=async()=>{try{await api("/api/bot/test",{method:"POST",body:JSON.stringify({chatId:$("#botChatId").value})}); botTestSucceeded=true; $("#botNotice").textContent="Đã gửi tin kiểm tra."; await loadBot(); updateBotStepButtons({ configured: true, chatId: $("#botChatId").value });}catch(e){$("#botNotice").textContent=e.message;}};
$("#botChatId")?.addEventListener("input", () => updateBotStepButtons({ configured: true, chatId: $("#botChatId").value }));
document.querySelectorAll(".ai-pick").forEach(btn => {
  btn.addEventListener("click", () => setAiProvider(btn.dataset.provider));
});
$("#detectAiCli")?.addEventListener("click", async () => {
  await updateAiStatusCard({ provider: getAiProvider(), enabled: $("#aiEnabled").checked, configured: false, model: $("#aiModel").value });
  const selected = await refreshAiCliStatus();
  if (selected?.ready || selected?.loggedIn) {
    if (!$("#aiEnabled").checked) {
      $("#aiNotice").textContent = "CLI đã đăng nhập. Bật AI và bấm Lưu để dùng cho báo cáo.";
      return;
    }
    $("#aiNotice").textContent = "Đã nhận đăng nhập. Đang lưu cấu hình…";
    await saveAiConfig({ enabled: true });
    showNotice("Đã kết nối và lưu AI.", "success");
  }
});
$("#installAiCli")?.addEventListener("click", async () => {
  const button = $("#installAiCli");
  try {
    button.disabled = true;
    button.textContent = "Đang cài đặt…";
    $("#aiNotice").textContent = "Đang cài CLI bằng npm (có thể mất 1–3 phút)…";
    const r = await api("/api/ai-cli/install", { method: "POST", body: JSON.stringify({ provider: getAiProvider() }) });
    showNotice(r.message || "Đã cài CLI.", "success");
    $("#aiNotice").textContent = r.message || "Đã cài xong.";
    await updateAiStatusCard({ provider: getAiProvider(), enabled: $("#aiEnabled").checked, configured: false, model: $("#aiModel").value });
  } catch (e) {
    $("#aiNotice").textContent = e.message;
    showNotice(e.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Cài đặt CLI";
  }
});
$("#updateAiCli")?.addEventListener("click", async () => {
  const button = $("#updateAiCli");
  try {
    button.disabled = true;
    button.textContent = "Đang cập nhật…";
    $("#aiNotice").textContent = "Đang cập nhật CLI bằng npm (có thể mất 1-3 phút)…";
    const r = await api("/api/ai-cli/update", { method: "POST", body: JSON.stringify({ provider: getAiProvider() }) });
    const text = [r.message, r.version ? `Phiên bản hiện tại: ${r.version}` : ""].filter(Boolean).join(" ");
    $("#aiNotice").textContent = text || "Đã cập nhật CLI.";
    showNotice(r.message || "Đã cập nhật CLI.", "success");
    await updateAiStatusCard({ provider: getAiProvider(), enabled: $("#aiEnabled").checked, configured: false, model: $("#aiModel").value });
  } catch (e) {
    $("#aiNotice").textContent = e.message;
    showNotice(e.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Cập nhật CLI";
  }
});
$("#loginAiCli")?.addEventListener("click", async () => {
  const button = $("#loginAiCli");
  const provider = getAiProvider();
  if (!isCliProviderId(provider)) {
    showNotice("Chọn ChatGPT/Codex hoặc Claude để đăng nhập CLI.", "error");
    return;
  }
  try {
    button.disabled = true;
    $("#aiNotice").textContent = "Đang kiểm tra/cài CLI rồi mở trình duyệt đăng nhập…";
    const r = await api("/api/ai-cli/login", { method: "POST", body: JSON.stringify({ provider, autoInstall: true }) });
    showNotice(r.message || "Đã mở đăng nhập trên trình duyệt.", "success");
    await pollCliLoginAfterBrowser();
  } catch (e) {
    $("#aiNotice").textContent = e.message;
    showNotice(e.message, "error");
  } finally {
    button.disabled = false;
  }
});
$("#installCliProxy")?.addEventListener("click", async () => {
  const button = $("#installCliProxy");
  try {
    button.disabled = true;
    button.textContent = "Đang tải…";
    $("#aiNotice").textContent = "Đang tải AI brain…";
    const r = await api("/api/cli-proxy-api/install", { method: "POST", body: "{}" });
    showNotice(r.message || "Xong.", "success");
    $("#aiNotice").textContent = r.message || "Xong.";
    await refreshCliProxyStatus();
  } catch (e) {
    $("#aiNotice").textContent = e.message;
    showNotice(e.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Tải AI brain";
  }
});
$("#startCliProxy")?.addEventListener("click", async () => {
  const button = $("#startCliProxy");
  try {
    button.disabled = true;
    $("#aiNotice").textContent = "Đang khởi động AI brain…";
    const r = await api("/api/cli-proxy-api/start", { method: "POST", body: "{}" });
    showNotice(r.message || "Đã khởi động.", "success");
    $("#aiNotice").textContent = r.message || "Tiếp theo: đăng nhập tài khoản.";
    await refreshCliProxyStatus();
  } catch (e) {
    $("#aiNotice").textContent = e.message;
    showNotice(e.message, "error");
  } finally {
    button.disabled = false;
  }
});
async function loginCliProxy(provider, label) {
  try {
    $("#aiNotice").textContent = `Đang mở đăng nhập ${label}…`;
    const r = await api("/api/cli-proxy-api/login", { method: "POST", body: JSON.stringify({ provider }) });
    showNotice(r.message || `Đã xử lý đăng nhập ${label}.`, "success");
    $("#aiNotice").textContent = r.message || "Hoàn tất trên trình duyệt rồi Quét lại.";
    await refreshCliProxyStatus();
  } catch (e) {
    $("#aiNotice").textContent = e.message;
    showNotice(e.message, "error");
  }
}
$("#loginCliProxyGoogle")?.addEventListener("click", () => loginCliProxy("antigravity", "Google"));
$("#loginCliProxyCodex")?.addEventListener("click", () => loginCliProxy("codex", "ChatGPT"));
$("#loginCliProxyClaude")?.addEventListener("click", () => loginCliProxy("claude", "Claude"));
$("#connectCliProxy")?.addEventListener("click", async () => {
  const button = $("#connectCliProxy");
  try {
    button.disabled = true;
    $("#aiNotice").textContent = "Đang kết nối AI brain…";
    setAiProvider("cliproxyapi", { refresh: false });
    const r = await api("/api/cli-proxy-api/connect", { method: "POST", body: "{}" });
    if (r.baseUrl && $("#aiBaseUrl")) $("#aiBaseUrl").value = r.baseUrl;
    if (r.model && $("#aiModel")) $("#aiModel").value = r.model;
    if (r.apiKey && $("#aiApiKey")) $("#aiApiKey").value = r.apiKey;
    $("#aiEnabled").checked = true;
    showNotice(r.message || "Đã kết nối AI brain.", "success");
    $("#aiNotice").textContent = r.message || "Đã kết nối.";
    aiSettingsEditing = false;
    await loadAi();
    await loadDashboard().catch(console.error);
  } catch (e) {
    $("#aiNotice").textContent = e.message;
    showNotice(e.message, "error");
  } finally {
    button.disabled = false;
  }
});
async function onRefreshCliProxy() {
  const status = await refreshCliProxyStatus();
  await updateAiStatusCard({ provider: "cliproxyapi", enabled: $("#aiEnabled").checked, cliProxyApi: status, connected: status?.ready });
}
$("#refreshCliProxy")?.addEventListener("click", () => onRefreshCliProxy());
$("#refreshCliProxyLogin")?.addEventListener("click", () => onRefreshCliProxy());
$("#refreshCliProxyConnect")?.addEventListener("click", () => onRefreshCliProxy());
$("#checkAiCliCompat")?.addEventListener("click", async () => {
  const button = $("#checkAiCliCompat");
  try {
    button.disabled = true;
    $("#aiNotice").textContent = "Đang kiểm tra tương thích CLI…";
    const r = await api("/api/ai-cli/compatibility", { method: "POST", body: JSON.stringify({ provider: getAiProvider() }) });
    const parts = [
      r.name ? `${r.name}` : "",
      r.installedVersion ? `Bản cài: ${r.installedVersion}` : "Chưa cài",
      r.latestVersion ? `Bản mới: ${r.latestVersion}` : "",
      r.updateAvailable ? "Có bản mới" : "Đang ở bản mới nhất",
      r.compatible ? "Tương thích" : "Có thể không tương thích",
      ...(r.suggestions || [])
    ].filter(Boolean);
    $("#aiNotice").textContent = parts.join(" · ");
    showNotice(r.compatible ? "Kiểm tra tương thích thành công." : "CLI có dấu hiệu chưa tương thích, hãy xem chi tiết.", r.compatible ? "success" : "error");
    await updateAiStatusCard({ provider: getAiProvider(), enabled: $("#aiEnabled").checked, configured: false, model: $("#aiModel").value });
  } catch (e) {
    $("#aiNotice").textContent = e.message;
    showNotice(e.message, "error");
  } finally {
    button.disabled = false;
  }
});
$("#logoutAiCli")?.addEventListener("click", async () => {
  const button = $("#logoutAiCli");
  if (!requireSecondClick(button, "Bấm lại để xóa phiên CLI đã chọn và đăng nhập lại.")) return;
  try {
    const r = await api("/api/ai-cli/logout", { method: "POST", body: JSON.stringify({ provider: getAiProvider() }) });
    showNotice(r.message || "Đã xóa phiên CLI.", "success");
    $("#aiNotice").textContent = r.message || "Đã xóa phiên.";
    await updateAiStatusCard({ provider: getAiProvider(), enabled: $("#aiEnabled").checked, configured: false, model: $("#aiModel").value });
  } catch (e) {
    $("#aiNotice").textContent = e.message;
    showNotice(e.message, "error");
  } finally {
    button.dataset.confirming = "false";
    button.textContent = button.dataset.originalText || "Xóa phiên / đăng xuất";
    button.classList.remove("confirming");
  }
});
$("#saveAi").onclick=async()=>{try{await saveAiConfig(); showNotice("Đã lưu cấu hình AI.","success");}catch(e){$("#aiNotice").textContent=e.message;showNotice(e.message,"error");}};
$("#editAiSettings")?.addEventListener("click", expandAiSettings);
$("#editBotSettings")?.addEventListener("click", expandBotSettings);
$("#toggleBotSettings")?.addEventListener("click", toggleBotSettingsPanel);
initUiScaleSelect($("#uiScale"));
$("#uiScale")?.addEventListener("change", () => {
  const scale = applyUiScale($("#uiScale").value);
  const notice = $("#uiScaleNotice");
  if (notice) notice.textContent = `Đã đặt tỉ lệ ${Math.round(scale * 100)}%.`;
});
if ($("#uiScaleNotice")) $("#uiScaleNotice").textContent = `Đang dùng ${Math.round(readUiScale() * 100)}%.`;
setAiProvider(getAiProvider(), { refresh: false });
$("#testAi").onclick=async()=>{try{$("#aiNotice").textContent="Đang kiểm tra kết nối AI…";const r=await api("/api/ai-config/test",{method:"POST",body:JSON.stringify({provider:getAiProvider(),enabled:$("#aiEnabled").checked})});$("#aiNotice").textContent=r.output||"Kết nối AI thành công.";showNotice("Kết nối AI thành công.","success");await loadDashboard().catch(console.error);}catch(e){$("#aiNotice").textContent=e.message;showNotice(e.message,"error");}};
$("#createDigestSchedule").onclick = async () => {
  try {
    const channels = selectedDigestChannels();
    if (!channels.length) throw new Error("Chọn ít nhất một kênh nhận");
    await api("/api/digest-schedules", {
      method: "POST",
      body: JSON.stringify({
        groupId: $("#digestScheduleGroup").value,
        timeOfDay: $("#digestScheduleTime").value,
        channels: channels.join(",")
      })
    });
    $("#digestScheduleNotice").textContent = "Đã tạo lịch tổng hợp hằng ngày.";
    showNotice("Đã tạo lịch tổng hợp.", "success");
    await loadDigestSchedules();
  } catch (e) {
    $("#digestScheduleNotice").textContent = e.message;
    showNotice(e.message, "error");
  }
};

const dt = new Date(Date.now() + 10 * 60000); dt.setSeconds(0,0); $("#runAt").value = new Date(dt.getTime() - dt.getTimezoneOffset()*60000).toISOString().slice(0,16);

function applySaasUi() {
  $("#dataLocationCard")?.classList.toggle("hidden", !appFeatures.dataLocation);
  $("#aiAccountConnectBlock")?.classList.toggle("hidden", saasMode);
  $("#aiApiConnectBlock")?.classList.toggle("hidden", !saasMode);
  $("#saasLogoutBtn")?.classList.toggle("hidden", !saasMode);
  if (saasMode && saasUser) {
    const box = $("#saasUserBox");
    if (box) {
      box.classList.remove("hidden");
      box.textContent = saasUser.email || saasUser.name || "Đã đăng nhập web";
    }
  }
  if (saasMode) {
    $("#aiProvider").value = "openai";
    setAiProvider("openai", { refresh: false });
  }
}

$("#saasLogoutBtn")?.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } catch {}
  location.replace("/login.html");
});

(async function boot() {
  try {
    const mode = await fetch("/api/app-mode").then(r => r.json());
    saasMode = Boolean(mode.saas);
    appFeatures = { ...appFeatures, ...(mode.features || {}) };
    if (saasMode) {
      const me = await fetch("/api/auth/me", { credentials: "same-origin" }).then(r => r.ok ? r.json() : null).catch(() => null);
      if (!me?.user) {
        location.replace("/login.html");
        return;
      }
      saasUser = me.user;
    }
    applySaasUi();
    const lic = await fetch("/api/license").then(r => r.json());
    if (!lic.ok) showLicenseGate(lic);
    else hideLicenseGate();
    await loadLicense().catch(() => {});
  } catch (e) {
    console.error(e);
  }
  setInterval(() => status().catch(console.error), 2000);
  status().catch(console.error);
  loadDashboard().catch(console.error);
  renderDailyTimes();
})();

$("#licenseForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#licenseGateError");
  if (err) err.textContent = "";
  try {
    await activateLicenseFromInput($("#licenseKeyInput"), err);
  } catch (ex) {
    if (err) err.textContent = ex.message;
  }
});
$("#licenseSettingsActivate")?.addEventListener("click", async () => {
  const notice = $("#licenseSettingsNotice");
  try {
    if (notice) notice.textContent = "Đang kích hoạt…";
    await activateLicenseFromInput($("#licenseSettingsKey"), notice);
  } catch (ex) {
    if (notice) notice.textContent = ex.message;
    showNotice(ex.message, "error");
  }
});
