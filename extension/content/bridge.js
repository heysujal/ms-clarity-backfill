// Runs in the extension's isolated world. Passes captured responses from
// hook.js (page world) to the background worker, and keeps diagnostics
// that panel.js (same isolated world) reads.
(() => {
  const MARK = "__clarityDataCapture__";
  const diag = (globalThis.__ccDiag = { network: 0, intercepted: 0, posted: 0, failed: 0, saved: 0, sendErrors: 0 });

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d[MARK] !== true) return;
    if (d.kind === "stats") {
      Object.assign(diag, d.stats);
      return;
    }
    try {
      chrome.runtime
        .sendMessage({ type: "capture", payload: { request: d.request, status: d.status, response: d.response } })
        .then((r) => {
          if (r && typeof r.saved === "number") diag.saved += r.saved;
        })
        .catch(() => diag.sendErrors++);
    } catch {
      // The extension was reloaded; this tab needs a refresh.
      diag.sendErrors++;
    }
  });
})();
