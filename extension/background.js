import { parseCapture, buildExport, exportForView, exportFilename, listViews } from "./lib/capture.js";

// Storage layout (chrome.storage.local):
//   "idx"       -> { [key]: {operation, projectId, from, to, filterSig, capturedAt} }
//   "rec:<key>" -> full record from parseCapture
//   "enabled"   -> boolean (default true)
//   "showPanel" -> boolean (default true): the panel on clarity.microsoft.com

let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

async function store(records) {
  const { idx = {} } = await chrome.storage.local.get("idx");
  const writes = {};
  for (const r of records) {
    writes["rec:" + r.key] = r;
    idx[r.key] = {
      operation: r.operation,
      projectId: r.projectId,
      from: r.range?.from ?? null,
      to: r.range?.to ?? null,
      filterSig: r.filterSig,
      capturedAt: r.capturedAt,
    };
  }
  writes.idx = idx;
  await chrome.storage.local.set(writes);
}

async function loadExport(opts = {}) {
  const { idx = {} } = await chrome.storage.local.get("idx");
  const keys = Object.keys(idx).map((k) => "rec:" + k);
  const recs = keys.length ? Object.values(await chrome.storage.local.get(keys)) : [];
  return buildExport(recs, opts);
}

async function exportJson({ viewKey = null, includeHeatmaps = false } = {}) {
  const exp = await loadExport({ includeHeatmaps });
  if (!viewKey) return { json: JSON.stringify(exp, null, 2), filename: exportFilename(null) };
  const v = exp.views.find((x) => x.key === viewKey);
  if (!v) throw new Error("That date range has no captured data yet.");
  return { json: JSON.stringify(exportForView(exp, v), null, 2), filename: exportFilename(v) };
}

async function updateBadge() {
  const { idx = {}, enabled = true } = await chrome.storage.local.get(["idx", "enabled"]);
  const n = Object.keys(idx).length;
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? "#171717" : "#8f8f8f" });
  await chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
  await chrome.action.setBadgeText({ text: n ? (n > 999 ? "999+" : String(n)) : enabled ? "" : "off" });
}

const handlers = {
  async capture(msg) {
    return serial(async () => {
      const { enabled = true } = await chrome.storage.local.get("enabled");
      if (!enabled) return { saved: 0 };
      const records = parseCapture(msg.payload);
      if (records.length) await store(records);
      return { saved: records.length };
    });
  },
  async listViews() {
    const exp = await loadExport();
    return { views: listViews(exp), projects: exp.projects };
  },
  async exportJson(msg) {
    return exportJson(msg);
  },
  async download(msg) {
    const { json, filename } = await exportJson(msg);
    // Service workers can't make blob URLs; a data URL works with chrome.downloads.
    const url = "data:application/json;charset=utf-8," + encodeURIComponent(json);
    await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" });
    return { ok: true, filename };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = msg && handlers[msg.type];
  if (!h) return;
  h(msg)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true; // async response
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.idx || changes.enabled)) updateBadge();
});

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
