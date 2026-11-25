// A floating panel on clarity.microsoft.com (isolated world, Shadow DOM so it
// can't clash with Clarity's styles). Changing the range here reloads the page
// with ?date=Last N days, which is the path that captures reliably.
(() => {
  if (window.top !== window || globalThis.__ccPanel) return;
  globalThis.__ccPanel = true;

  const PRESETS = [
    { n: 3, label: "3D" },
    { n: 7, label: "7D" },
    { n: 30, label: "30D" },
    { n: 90, label: "90D" },
    { n: 180, label: "180D" },
    { n: 365, label: "1Y" },
  ];
  const PAGES = [
    { path: "dashboard", label: "Dashboard", has: (v) => v && Object.keys(v.summary || {}).length > 0 },
    { path: "impressions", label: "Recordings", has: (v) => v && v.sessionsCaptured > 0 },
    { path: "heatmaps", label: "Heatmaps", has: (_v, hm) => hm > 0 },
  ];

  // ---------- fonts (document-level @font-face; Shadow DOM inherits families) ----------
  const fontCss = document.createElement("style");
  fontCss.textContent = `
    @font-face { font-family: "CC Geist"; src: url("${chrome.runtime.getURL("fonts/Geist-Variable.woff2")}") format("woff2"); font-weight: 100 900; font-display: swap; }
    @font-face { font-family: "CC Geist Mono"; src: url("${chrome.runtime.getURL("fonts/GeistMono-Variable.woff2")}") format("woff2"); font-weight: 100 900; font-display: swap; }`;
  (document.head || document.documentElement).append(fontCss);

  // ---------- helpers ----------
  const send = (msg) =>
    chrome.runtime.sendMessage(msg).then((r) => {
      if (r && r.error) throw new Error(r.error);
      return r;
    });
  const nf = new Intl.NumberFormat();
  const num = (v) => (typeof v === "number" ? nf.format(Math.round(v * 100) / 100) : "—");
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const fmtDate = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function pageState() {
    const m = location.pathname.match(/^\/projects\/view\/([^/]+)\/([^/?#]+)/);
    const raw = new URLSearchParams(location.search).get("date");
    const dm = raw && raw.match(/^Last\s+(\d+)\s+days?$/i);
    const days = dm ? Number(dm[1]) : raw ? null : 3; // Clarity's default is the last 3 days
    let fromDate = null;
    let toDate = null;
    if (days) {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - (days - 1));
      fromDate = ymd(start);
      toDate = ymd(end);
    }
    return { projectId: m?.[1] ?? null, page: m?.[2] ?? null, rawDate: raw, days, fromDate, toDate };
  }

  function goto({ days, page }) {
    const st = pageState();
    if (!st.projectId) return;
    const u = new URL(location.href);
    if (page) u.pathname = `/projects/view/${st.projectId}/${page}`;
    if (days) u.searchParams.set("date", `Last ${days} days`);
    location.assign(u.toString());
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  function anchorDownload(json, filename) {
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.split("/").pop();
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // ---------- DOM ----------
  const host = document.createElement("div");
  host.id = "clarity-data-capture";
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483646; right: 20px; bottom: 20px;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .t {
    --bg: #ffffff; --bg-2: #fafafa; --bg-hover: #f2f2f2; --border: #ebebeb; --border-strong: #d4d4d4;
    --text: #171717; --text-2: #4d4d4d; --muted: #8f8f8f;
    --inv-bg: #171717; --inv-text: #ffffff;
    --blue: #006bff; --green: #1a9b4b; --amber: #c27803; --red: #e5484d;
    --shadow: 0 0 0 1px rgba(0,0,0,.06), 0 8px 24px -4px rgba(0,0,0,.12), 0 2px 6px rgba(0,0,0,.04);
    font-family: "CC Geist", "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13px; line-height: 1.45; color: var(--text);
    -webkit-font-smoothing: antialiased;
  }
  @media (prefers-color-scheme: dark) {
    .t {
      --bg: #0a0a0a; --bg-2: #111111; --bg-hover: #1a1a1a; --border: #242424; --border-strong: #3a3a3a;
      --text: #ededed; --text-2: #a1a1a1; --muted: #737373;
      --inv-bg: #ededed; --inv-text: #0a0a0a;
      --blue: #52a8ff; --green: #3ecf8e; --amber: #f5a524; --red: #ff6166;
      --shadow: 0 0 0 1px rgba(255,255,255,.08), 0 8px 24px -4px rgba(0,0,0,.6);
    }
  }
  .mono { font-family: "CC Geist Mono", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }

  .launcher {
    display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px 0 12px;
    border-radius: 999px; border: 0; background: var(--inv-bg); color: var(--inv-text);
    font-weight: 500; box-shadow: var(--shadow); letter-spacing: -0.01em;
  }
  .launcher:hover { opacity: .92; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot.on { background: var(--green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--green) 25%, transparent); }
  .count { font-size: 12px; opacity: .7; }

  .panel {
    position: absolute; right: 0; bottom: 48px; width: 360px; max-height: calc(100vh - 100px); overflow: auto;
    background: var(--bg); border-radius: 12px; box-shadow: var(--shadow);
  }
  .panel[hidden] { display: none; }
  .head { display: flex; align-items: flex-start; gap: 8px; padding: 14px 16px 12px; border-bottom: 1px solid var(--border); }
  .head h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
  .head p { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
  .icon-btn { margin-left: auto; width: 28px; height: 28px; border-radius: 6px; border: 0; background: transparent; color: var(--text-2); display: grid; place-items: center; }
  .icon-btn:hover { background: var(--bg-hover); color: var(--text); }

  section { padding: 14px 16px; border-bottom: 1px solid var(--border); }
  section:last-of-type { border-bottom: 0; }
  .label { font-size: 12px; color: var(--muted); font-weight: 500; margin: 0 0 8px; display: flex; align-items: center; gap: 6px; }

  .seg { display: grid; grid-template-columns: repeat(6, 1fr); padding: 2px; gap: 2px; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; }
  .seg button { height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--text-2); font-size: 12px; font-weight: 500; }
  .seg button:hover { color: var(--text); }
  .seg button[aria-pressed="true"] { background: var(--bg); color: var(--text); box-shadow: 0 0 0 1px var(--border-strong), 0 1px 2px rgba(0,0,0,.06); }

  .custom { display: flex; align-items: center; gap: 8px; margin-top: 10px; color: var(--text-2); }
  .input { display: flex; align-items: center; height: 32px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg); padding: 0 8px; gap: 6px; flex: 1; }
  .input:focus-within { border-color: var(--text-2); box-shadow: 0 0 0 3px color-mix(in srgb, var(--text) 8%, transparent); }
  .input input { all: unset; width: 100%; font-family: inherit; font-size: 13px; color: var(--text); }
  .input span { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .hint { margin: 8px 0 0; font-size: 12px; color: var(--muted); }

  .btn { height: 32px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); font-weight: 500; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; }
  .btn:hover { background: var(--bg-hover); }
  .btn.primary { background: var(--inv-bg); color: var(--inv-text); border-color: var(--inv-bg); }
  .btn.primary:hover { opacity: .9; background: var(--inv-bg); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.full { flex: 1; }
  .link { all: unset; cursor: pointer; color: var(--text-2); font-size: 12px; text-decoration: underline; text-decoration-color: var(--border-strong); text-underline-offset: 3px; }
  .link:hover { color: var(--text); }

  .range-title { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
  .range-sub { font-size: 12px; color: var(--muted); margin: 2px 0 12px; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .stat { padding: 8px 10px; }
  .stat + .stat { border-left: 1px solid var(--border); }
  .stat .k { font-size: 11px; color: var(--muted); }
  .stat .v { font-size: 16px; font-weight: 600; margin-top: 2px; letter-spacing: -0.01em; }

  .pages { display: grid; gap: 6px; margin-top: 12px; }
  .page { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); text-align: left; width: 100%; }
  .page:hover { background: var(--bg-hover); }
  .page.current { border-color: var(--border-strong); }
  .page .name { font-weight: 500; }
  .page .meta { margin-left: auto; font-size: 12px; color: var(--muted); }
  .check { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--border-strong); display: grid; place-items: center; flex: none; }
  .check.done { background: var(--green); border-color: var(--green); color: #fff; }

  .actions { display: flex; gap: 8px; }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
  .empty { padding: 12px; border: 1px dashed var(--border-strong); border-radius: 8px; color: var(--text-2); font-size: 12px; }
  .diag { padding: 10px 16px; font-size: 11px; color: var(--muted); display: flex; align-items: center; gap: 6px; background: var(--bg-2); border-top: 1px solid var(--border); border-radius: 0 0 12px 12px; }
  .diag.warn { color: var(--amber); }
  .toast { position: absolute; right: calc(100% + 10px); bottom: 4px; transform: translateX(6px); opacity: 0; pointer-events: none; transition: .18s ease; background: var(--inv-bg); color: var(--inv-text); padding: 8px 12px; border-radius: 8px; font-size: 12px; font-weight: 500; white-space: nowrap; box-shadow: var(--shadow); }
  .toast.show { opacity: 1; transform: none; }
</style>
<div class="t">
  <div class="panel" id="panel" hidden role="dialog" aria-label="Clarity Data Capture">
    <div class="head">
      <div>
        <h1>Clarity Capture</h1>
        <p id="project"></p>
      </div>
      <button class="icon-btn" id="close" aria-label="Close" title="Close">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
      </button>
    </div>
    <section>
      <p class="label">Date range</p>
      <div class="seg" id="seg"></div>
      <form class="custom" id="customForm">
        <label class="input"><span>Last</span><input id="customDays" type="number" min="1" max="1000" inputmode="numeric" placeholder="300" aria-label="Number of days" /><span>days</span></label>
        <button class="btn" type="submit">Apply</button>
      </form>
      <p class="hint">Reloads the page with this range so everything Clarity loads gets saved.</p>
    </section>
    <section id="current"></section>
    <section>
      <div class="actions">
        <button class="btn full" id="copyView">Copy JSON</button>
        <button class="btn primary full" id="downloadView">Download JSON</button>
      </div>
      <div class="row">
        <span style="color:var(--muted);font-size:12px">All captured data:</span>
        <button class="link" id="copyAll">Copy</button>
        <button class="link" id="downloadAll">Download</button>
        <button class="link" id="openViewer" style="margin-left:auto">Full view ↗</button>
      </div>
    </section>
    <div class="diag mono" id="diag"></div>
  </div>
  <button class="launcher" id="launcher" aria-expanded="false" aria-controls="panel">
    <span class="dot" id="dot"></span><span>Capture</span><span class="count mono" id="count"></span>
  </button>
  <div class="toast" id="toast" role="status"></div>
</div>`;

  const $ = (id) => root.getElementById(id);
  let views = [];
  let projects = {};
  let currentView = null;
  let enabled = true;

  const toast = (msg) => {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove("show"), 1800);
  };

  function setOpen(open) {
    $("panel").hidden = !open;
    $("launcher").setAttribute("aria-expanded", String(open));
    chrome.storage.local.set({ panelOpen: open });
    if (open) render();
  }

  // ---------- render ----------
  function render() {
    const st = pageState();
    const p = projects[st.projectId];
    $("project").textContent = st.projectId ? `${p?.name || st.projectId}${st.page ? " · " + st.page.replace("impressions", "recordings") : ""}` : "Open a project to pick a range";

    $("seg").innerHTML = PRESETS.map(
      (x) => `<button type="button" data-days="${x.n}" aria-pressed="${st.days === x.n}">${x.label}</button>`,
    ).join("");
    if (st.days && !PRESETS.some((x) => x.n === st.days) && document.activeElement !== host) $("customDays").value = st.days;

    currentView = st.projectId && st.fromDate
      ? views.find((v) => v.projectId === st.projectId && !v.filters.length && v.fromDate === st.fromDate && v.toDate === st.toDate) || null
      : null;
    const heatmaps = st.projectId && st.fromDate
      ? views.filter((v) => v.projectId === st.projectId && v.filters.length && v.fromDate === st.fromDate && v.toDate === st.toDate).reduce((n, v) => n + v.heatmaps, 0)
      : 0;

    const cur = $("current");
    if (!st.projectId) {
      cur.innerHTML = `<div class="empty">Open one of your projects in Clarity to see what's captured for its date range.</div>`;
    } else if (!st.days) {
      cur.innerHTML = `<p class="label">This range</p><div class="empty">This page uses a range the panel can't read (<span class="mono">${esc(st.rawDate)}</span>). Pick a range above to capture it reliably.</div>`;
    } else {
      const s = currentView?.summary || {};
      const title = `${fmtDate(st.fromDate)} – ${fmtDate(st.toDate)}`;
      cur.innerHTML = `
        <p class="label">This range</p>
        <p class="range-title">${esc(title)}</p>
        <p class="range-sub">${st.days} day${st.days > 1 ? "s" : ""}${currentView ? ` · ${currentView.dataTypes} data types` : " · nothing captured yet"}</p>
        <div class="stats">
          <div class="stat"><div class="k">Sessions</div><div class="v mono">${num(s.sessions)}</div></div>
          <div class="stat"><div class="k">Users</div><div class="v mono">${num(s.uniqueUsers)}</div></div>
          <div class="stat"><div class="k">Recordings</div><div class="v mono">${num(currentView?.sessionsCaptured ?? 0)}</div></div>
        </div>
        <div class="pages">
          ${PAGES.map((pg) => {
            const done = pg.has(currentView, heatmaps);
            const meta = pg.path === "impressions" && currentView?.sessionsCaptured
              ? `${num(currentView.sessionsCaptured)}${currentView.sessionsCount ? " of " + num(currentView.sessionsCount) : ""}`
              : pg.path === "heatmaps" && heatmaps ? `${heatmaps} page${heatmaps > 1 ? "s" : ""}` : done ? "Captured" : st.page === pg.path ? "Loading…" : "Open to capture";
            return `<button type="button" class="page${st.page === pg.path ? " current" : ""}" data-page="${pg.path}">
              <span class="check${done ? " done" : ""}">${done ? '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 8.5l3.2 3L13 5"/></svg>' : ""}</span>
              <span class="name">${pg.label}</span><span class="meta">${meta}</span></button>`;
          }).join("")}
        </div>`;
    }
    $("copyView").disabled = $("downloadView").disabled = !currentView;
    $("copyAll").disabled = $("downloadAll").disabled = !views.length;
    renderLauncher();
    renderDiag();
  }

  function renderLauncher() {
    $("dot").classList.toggle("on", enabled);
    $("count").textContent = views.length ? String(views.length) : "";
    $("launcher").title = enabled ? "Capturing Clarity data" : "Capture is off";
  }

  function renderDiag() {
    const d = globalThis.__ccDiag || {};
    const missed = Math.max(0, (d.network || 0) - (d.intercepted || 0));
    const el = $("diag");
    el.classList.toggle("warn", missed > 0 || d.sendErrors > 0 || !enabled);
    el.textContent = !enabled
      ? "Capture is off (turn it on in the extension popup)"
      : d.sendErrors
        ? `Extension was reloaded — refresh this tab`
        : `API calls ${d.network || 0} · intercepted ${d.intercepted || 0} · saved ${d.saved || 0}${missed ? ` · ${missed} missed` : ""}`;
  }

  async function refresh() {
    try {
      const r = await send({ type: "listViews" });
      views = r.views || [];
      projects = r.projects || {};
    } catch {
      /* extension reloaded */
    }
    render();
  }

  // ---------- events ----------
  $("launcher").addEventListener("click", () => setOpen($("panel").hidden));
  $("close").addEventListener("click", () => setOpen(false));
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("panel").hidden) setOpen(false);
  });
  $("seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-days]");
    if (b) goto({ days: Number(b.dataset.days) });
  });
  $("customForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const n = Math.round(Number($("customDays").value));
    if (!n || n < 1 || n > 1000) return toast("Enter 1–1000 days");
    goto({ days: n });
  });
  $("current").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-page]");
    if (b) goto({ page: b.dataset.page, days: pageState().days || undefined });
  });

  async function doCopy(viewKey) {
    try {
      const { json } = await send({ type: "exportJson", viewKey });
      const ok = await copyText(json);
      toast(ok ? `Copied ${(json.length / 1024).toFixed(0)} KB of JSON` : "Copy failed");
    } catch (e) {
      toast(e.message);
    }
  }
  async function doDownload(viewKey) {
    try {
      const r = await send({ type: "download", viewKey });
      toast(`Saved to Downloads/${r.filename}`);
    } catch {
      try {
        const { json, filename } = await send({ type: "exportJson", viewKey });
        anchorDownload(json, filename);
        toast("Saved to Downloads");
      } catch (e) {
        toast(e.message);
      }
    }
  }
  $("copyView").addEventListener("click", () => currentView && doCopy(currentView.key));
  $("downloadView").addEventListener("click", () => currentView && doDownload(currentView.key));
  $("copyAll").addEventListener("click", () => doCopy(null));
  $("downloadAll").addEventListener("click", () => doDownload(null));
  $("openViewer").addEventListener("click", () => window.open(chrome.runtime.getURL("viewer/viewer.html"), "_blank"));

  let refreshTimer = null;
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "local") return;
    if (c.enabled) {
      enabled = c.enabled.newValue !== false;
      renderLauncher();
      renderDiag();
    }
    if (c.showPanel) host.style.display = c.showPanel.newValue === false ? "none" : "";
    if (c.idx) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 700);
    }
  });

  // Clarity is a single-page app: follow URL changes made by its own UI.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      render();
    } else if (!$("panel").hidden) {
      renderDiag();
    }
  }, 700);

  // ---------- boot ----------
  const mount = async () => {
    const s = await chrome.storage.local.get(["enabled", "showPanel", "panelOpen"]);
    enabled = s.enabled !== false;
    if (s.showPanel === false) host.style.display = "none";
    document.documentElement.append(host);
    await refresh();
    if (s.panelOpen) setOpen(true);
  };
  if (document.body) mount();
  else window.addEventListener("DOMContentLoaded", mount, { once: true });
})();
