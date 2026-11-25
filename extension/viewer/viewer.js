import {
  loadExport, downloadJson, copyJson, kb, exportFilename, singleViewExport, clearAll,
  fmt, el, viewTitle, viewKind, describeFilter,
} from "../ui/common.js";

const $ = (id) => document.getElementById(id);
const opts = () => ({ includeHeatmaps: $("heatmaps").checked, includeRaw: $("raw").checked });
const toast = (msg) => {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1800);
};

function kpi(label, value) {
  return el("div", { class: "kpi" }, el("div", { class: "label" }, label), el("div", { class: "value" }, value));
}

function list(title, rows, cols) {
  if (!rows?.length) return null;
  return el("div", {},
    el("h3", { style: "margin-bottom:4px" }, title),
    el("table", {},
      el("thead", {}, el("tr", {}, cols.map((c) => el("th", { class: c.num ? "num" : null }, c.label)))),
      el("tbody", {}, rows.slice(0, 10).map((r) =>
        el("tr", {}, cols.map((c) => {
          const v = c.get(r);
          return el("td", { class: c.num ? "num" : null, title: c.num ? null : String(v ?? "") }, c.num ? fmt.n(v) : v ?? "—");
        })),
      )),
    ),
  );
}

const shortUrl = (u) => {
  try {
    const x = new URL(u);
    return (x.pathname + (x.search ? x.search : "")) || "/";
  } catch {
    return u;
  }
};

function dashboardCard(exp, v) {
  const s = v.summary, m = v.metrics;
  const kpis = [
    ["Sessions", fmt.n(s.sessions)],
    ["Unique users", fmt.n(s.uniqueUsers)],
    ["Pages / session", fmt.n(s.pagesPerSession)],
    ["Scroll depth", fmt.pct(s.scrollDepthPercent)],
    ["Active time", fmt.sec(s.avgActiveTimeSec)],
    ["Bot sessions", fmt.n(s.botSessions)],
    ["Dead clicks", fmt.n(s.deadClicksSessions)],
    ["Rage clicks", fmt.n(s.rageClicksSessions)],
    ["Quick backs", fmt.n(s.quickBacksSessions)],
    ["JS errors", fmt.n(s.jsErrorsSessions)],
    ["Perf score", fmt.n(s.performanceScore)],
  ].filter(([, val]) => val !== "—");

  const pages = m.topPathsWithTitleAndParams || m.topPaths;
  const funnels = v.funnels.map((f) => ({
    name: f.name || f.funnelId.slice(0, 8),
    first: f.steps[0]?.sessions,
    last: f.steps[f.steps.length - 1]?.sessions,
  }));

  return el("div", { class: "card view stack" },
    header(exp, v),
    kpis.length ? el("div", { class: "kpis" }, kpis.map(([l, val]) => kpi(l, val))) : null,
    el("div", { class: "lists" },
      list("Top pages", pages, [
        { label: "Page", get: (r) => r.pageTitle ? `${r.pageTitle} — ${shortUrl(r.item)}` : shortUrl(r.item) },
        { label: "Sessions", num: true, get: (r) => r.count },
      ]),
      list("Referrers", m.referrers, [
        { label: "Referrer", get: (r) => r.item },
        { label: "Sessions", num: true, get: (r) => r.count },
      ]),
      list("Smart events", m.smartEvents, [
        { label: "Event", get: (r) => r.name },
        { label: "Count", num: true, get: (r) => r.count },
      ]),
      list("Devices", m.devices, [
        { label: "Device", get: (r) => r.item },
        { label: "Sessions", num: true, get: (r) => r.count },
      ]),
      list("Browsers", m.browsers, [
        { label: "Browser", get: (r) => r.item },
        { label: "Sessions", num: true, get: (r) => r.count },
      ]),
      list("Funnels (first → last step)", funnels, [
        { label: "Funnel", get: (r) => r.name },
        { label: "Start", num: true, get: (r) => r.first },
        { label: "End", num: true, get: (r) => r.last },
      ]),
    ),
    footer(exp, v),
  );
}

function header(exp, v) {
  const name = exp.projects[v.projectId]?.name || v.projectId;
  return el("div", { class: "row wrap" },
    el("div", { style: "min-width:0" },
      el("h2", {}, viewTitle(v)),
      el("p", { class: "small muted" }, `${v.days} day${v.days > 1 ? "s" : ""} · ${name} · captured ${fmt.ago(v.lastCapturedAt)}`),
    ),
    el("span", { class: "spacer" }),
    el("button", { onclick: async () => toast(`Copied ${kb(await copyJson(singleViewExport(await loadExport(opts()), v)))}`) }, "Copy JSON"),
    el("button", {
      class: "primary",
      onclick: async () => {
        await downloadJson(singleViewExport(await loadExport(opts()), v), exportFilename(v));
        toast("Saved to Downloads/clarity-exports");
      },
    }, "Download JSON"),
  );
}

function footer(exp, v) {
  const chips = [
    ...v.filters.map((f) => el("span", { class: "chip accent", title: describeFilter(f) }, describeFilter(f))),
    el("span", { class: "chip" }, `${v.operations.length} data type${v.operations.length > 1 ? "s" : ""}`),
  ];
  if (v.sessionsCaptured || v.sessionsCount) {
    const of = v.sessionsCount ? ` of ${fmt.n(v.sessionsCount)}` : "";
    chips.push(el("span", { class: "chip", title: "Scroll or page through Recordings in Clarity to capture more" }, `${fmt.n(v.sessionsCaptured)}${of} recordings`));
  }
  if (v.heatmaps.length) chips.push(el("span", { class: "chip" }, `${v.heatmaps.length} heatmap${v.heatmaps.length > 1 ? "s" : ""}`));
  const pre = el("pre");
  const det = el("details", {
    ontoggle: () => {
      if (det.open && !pre.textContent) {
        const json = JSON.stringify(v, null, 2);
        pre.textContent = json.length > 60_000 ? json.slice(0, 60_000) + "\n… (truncated in preview; the download has everything)" : json;
      }
    },
  }, el("summary", {}, "Preview JSON"), pre);
  return el("div", { class: "stack" }, el("div", { class: "row wrap" }, chips), det);
}

function compactCard(exp, v) {
  const kind = viewKind(v);
  const label = kind === "heatmap"
    ? `Heatmap · ${v.heatmaps.map((h) => shortUrl(h.url)).join(", ")}`
    : v.filters.length ? v.filters.map(describeFilter).join(" · ") : "Partial data";
  return el("div", { class: "card compact" },
    el("div", { class: "row" },
      el("div", { style: "min-width:0" },
        el("p", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, label),
        el("p", { class: "small muted" }, `${viewTitle(v)} · ${v.days} days · captured ${fmt.ago(v.lastCapturedAt)}`),
      ),
      el("span", { class: "spacer" }),
      el("button", { class: "sm", onclick: async () => toast(`Copied ${kb(await copyJson(singleViewExport(await loadExport(opts()), v)))}`) }, "Copy"),
      el("button", {
        class: "sm",
        onclick: async () => {
          await downloadJson(singleViewExport(await loadExport(opts()), v), exportFilename(v));
          toast("Saved to Downloads/clarity-exports");
        },
      }, "JSON"),
    ),
  );
}

async function render() {
  const exp = await loadExport(opts());
  const main = $("main");
  main.replaceChildren();
  $("count").textContent = `${exp.views.length} view${exp.views.length === 1 ? "" : "s"}`;
  $("downloadAll").disabled = $("copyAll").disabled = !exp.views.length;

  if (!exp.views.length) {
    main.append(el("div", { class: "card empty stack" },
      el("h2", {}, "Nothing captured yet"),
      el("p", {}, "Open clarity.microsoft.com in this Chrome profile, choose any date range (even 'All time' or a custom range) and open the pages you want: Dashboard, Recordings, Heatmaps."),
      el("p", { class: "muted small" }, "The extension saves the data Clarity loads for you. It never sends requests of its own."),
    ));
    return;
  }

  const byProject = new Map();
  for (const v of exp.views) {
    if (!byProject.has(v.projectId)) byProject.set(v.projectId, []);
    byProject.get(v.projectId).push(v);
  }
  for (const [pid, views] of byProject) {
    const p = exp.projects[pid];
    const sec = el("section", { class: "project" },
      el("div", { class: "row", style: "margin-bottom:10px" },
        el("h2", {}, p?.name || pid),
        p?.hostname ? el("span", { class: "muted small" }, p.hostname) : null,
      ),
    );
    const full = views.filter((v) => viewKind(v) === "dashboard" || viewKind(v) === "recordings");
    const rest = views.filter((v) => !full.includes(v));
    for (const v of full) sec.append(dashboardCard(exp, v));
    if (rest.length) {
      sec.append(el("h3", { style: "margin:16px 0 6px" }, "Heatmaps and filtered views"));
      for (const v of rest) sec.append(compactCard(exp, v));
    }
    main.append(sec);
  }
}

$("copyAll").addEventListener("click", async () => toast(`Copied ${kb(await copyJson(await loadExport(opts())))}`));
$("downloadAll").addEventListener("click", async () => {
  await downloadJson(await loadExport(opts()), exportFilename(null));
  toast("Saved to Downloads/clarity-exports");
});
$("clear").addEventListener("click", async () => {
  if (!confirm("Delete all captured Clarity data from this browser?")) return;
  await clearAll();
  render();
});
$("heatmaps").addEventListener("change", render);
$("raw").addEventListener("change", render);

// Live-update while Clarity is open in another tab.
let pending = null;
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local" || !c.idx) return;
  clearTimeout(pending);
  pending = setTimeout(render, 600);
});

render();
