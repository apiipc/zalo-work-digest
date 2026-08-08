export const UI_SCALE_KEY = "zalo-digest-ui-scale";
export const UI_SCALE_DEFAULT = 1;

export const UI_SCALE_OPTIONS = [
  { value: 0.85, label: "85% — nhỏ hơn" },
  { value: 0.9, label: "90%" },
  { value: 0.95, label: "95%" },
  { value: 1, label: "100% — mặc định" },
  { value: 1.05, label: "105%" },
  { value: 1.1, label: "110%" },
  { value: 1.15, label: "115%" },
  { value: 1.25, label: "125% — lớn hơn" }
];

export function readUiScale() {
  const raw = localStorage.getItem(UI_SCALE_KEY);
  const n = Number(raw);
  if (!raw || Number.isNaN(n)) return UI_SCALE_DEFAULT;
  const allowed = UI_SCALE_OPTIONS.some(o => o.value === n);
  return allowed ? n : UI_SCALE_DEFAULT;
}

export function applyUiScale(scale) {
  const n = Number(scale) || UI_SCALE_DEFAULT;
  document.documentElement.style.zoom = String(n);
  localStorage.setItem(UI_SCALE_KEY, String(n));
  return n;
}

export function initUiScaleSelect(selectEl) {
  if (!selectEl) return;
  selectEl.innerHTML = UI_SCALE_OPTIONS.map(
    o => `<option value="${o.value}">${o.label}</option>`
  ).join("");
  selectEl.value = String(readUiScale());
}
