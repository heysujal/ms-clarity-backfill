import { buildExport, exportFilename, exportForView } from "../lib/capture.js";

export async function loadRecords() {
  const { idx = {} } = await chrome.storage.local.get("idx");
  const keys = Object.keys(idx).map((k) => "rec:" + k);
  if (!keys.length) return [];
  const got = await chrome.storage.local.get(keys);
  return Object.values(got);
}

export async function loadExport(opts = {}) {
  return buildExport(await loadRecords(), opts);
}

export async function clearAll() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k === "idx" || k.startsWith("rec:"));
  await chrome.storage.local.remove(keys);
}

export async function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export const singleViewExport = exportForView;

export async function copyJson(obj) {
  const text = JSON.stringify(obj, null, 2);
  await navigator.clipboard.writeText(text);
  return text.length;
}

export const kb = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export { exportFilename };

const nf = new Intl.NumberFormat();
export const fmt = {
  n: (v) => (typeof v === "number" ? nf.format(Math.round(v * 100) / 100) : "—"),
  pct: (v) => (typeof v === "number" ? `${Math.round(v * 10) / 10}%` : "—"),
  sec: (v) => {
    if (typeof v !== "number") return "—";
    const m = Math.floor(v / 60);
    const s = Math.round(v % 60);
    return m ? `${m}m ${s}s` : `${s}s`;
  },
  date: (ymd) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  },
  ago: (iso) => {
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  },
};

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

export function describeFilter(f) {
  const field = f.field === "Url" ? "URL" : f.field;
  const op = { RegexMatch: "matches", Equals: "is", Contains: "contains", Range: "in", Greater: ">", Less: "<" }[f.operator] || f.operator;
  let val = typeof f.value === "object" ? JSON.stringify(f.value) : String(f.value);
  if (f.field === "Url") val = val.replace(/^\^/, "").replace(/\\\./g, ".").replace(/\\\?/g, "?").replace(/\(\\\?\.\*\)\?\$$/, "").replace(/\$$/, "");
  return `${f.invert ? "NOT " : ""}${field} ${op} ${val}`;
}

export function viewTitle(v) {
  return `${fmt.date(v.fromDate)} – ${fmt.date(v.toDate)}`;
}

// Is this a full dashboard view or a narrow one (e.g. a heatmap for one URL)?
export function viewKind(v) {
  if (v.summary && Object.keys(v.summary).length) return "dashboard";
  if (v.heatmaps.length && !v.sessionsCaptured) return "heatmap";
  if (v.sessionsCaptured) return "recordings";
  return "partial";
}
