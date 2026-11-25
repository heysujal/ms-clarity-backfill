// Pure functions (no chrome.* APIs) so they can be tested in Node.
// 1. parseCapture: turns one captured /api/v2 request+response into records.
// 2. buildExport: merges stored records into a clean JSON export.

// Operations that are telemetry or personal account info, not analytics data.
export const IGNORED_OPS = new Set([
  "batchEvents",
  "sendError",
  "getAccountStatus",
  "getIntegratedCdnProviders",
  "getDynamicModules",
]);

const DATE_FIELD = "minEnqueuedTimestamp";

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

export function stripTypename(v) {
  if (Array.isArray(v)) return v.map(stripTypename);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) if (k !== "__typename") out[k] = stripTypename(val);
    return out;
  }
  return v;
}

function safeJson(s) {
  if (typeof s !== "string") return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Clarity filters look like {"operator":"And","filters":[{field,dataType,operator,value}, ...]}
// or a single condition. Returns {range, extra} where extra = every condition
// except the date range and the default "pageDuration > 0".
export function splitFilter(filter) {
  let range = null;
  const extra = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.filters)) {
      node.filters.forEach(walk);
      return;
    }
    if (node.field === DATE_FIELD && node.value && node.value.min) {
      range = { from: node.value.min, to: node.value.max };
      return;
    }
    if (node.field === "pageDuration" && node.operator === "Greater" && node.value === 0) return;
    if (node.field) extra.push(node);
  };
  walk(filter);
  return { range, extra };
}

export function localDate(iso, timeZone) {
  // YYYY-MM-DD in the given (or the system) time zone.
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return parts; // en-CA formats as YYYY-MM-DD
}

/**
 * @param {{request: string, status: number, response: string}} cap
 * @returns {Array<object>} records ready to store (may be empty)
 */
export function parseCapture(cap, now = Date.now()) {
  const req = safeJson(cap.request);
  const res = safeJson(cap.response);
  if (!req || !res || cap.status !== 200) return [];
  const reqs = Array.isArray(req) ? req : [req];
  const ress = Array.isArray(res) ? res : [res];
  const out = [];
  reqs.forEach((r, i) => {
    const body = ress[i];
    const op = r && r.operationName;
    if (!op || IGNORED_OPS.has(op) || !body || !body.data) return;
    const vars = (r.variables && typeof r.variables === "object") ? r.variables : {};
    const filterStr = vars.filters ?? vars.filter ?? vars.serializedFilter;
    const filter = safeJson(filterStr);
    const { range, extra } = splitFilter(filter);
    const context = {};
    for (const [k, v] of Object.entries(vars)) {
      if (["filters", "filter", "serializedFilter", "projectId", "id"].includes(k)) continue;
      context[k] = v;
    }
    out.push({
      // Same operation + variables can request different fields, so the query text is part of the key.
      key: fnv1a(op + "|" + fnv1a(String(r.query || "")) + "|" + stableStringify(vars)),
      operation: op,
      projectId: vars.projectId || vars.id || null,
      range,
      extraFilters: extra,
      filterSig: stableStringify(extra),
      variables: context,
      capturedAt: now,
      hadErrors: Array.isArray(body.errors) && body.errors.length > 0,
      data: stripTypename(body.data),
    });
  });
  return out;
}

const round = (n, d = 2) => (typeof n === "number" ? Math.round(n * 10 ** d) / 10 ** d : n);

function summarize(m) {
  const s = {};
  if (m.sessions) {
    s.sessions = m.sessions.totalSessions;
    s.botSessions = m.sessions.totalBotSessions;
  }
  if (m.totalUsers != null) s.uniqueUsers = m.totalUsers;
  if (m.newAndReturning) {
    s.newUserSessions = m.newAndReturning.newUsers;
    s.returningUserSessions = m.newAndReturning.returningUsers;
  }
  if (m.pagesPerSession != null) s.pagesPerSession = round(m.pagesPerSession);
  if (m.scrollDepth != null) s.scrollDepthPercent = round(m.scrollDepth);
  if (m.engagement) {
    s.avgTotalTimeSec = m.engagement.totalTime;
    s.avgActiveTimeSec = m.engagement.activeTime;
  }
  for (const k of ["rageClicks", "deadClicks", "excessiveScrolls", "quickBacks", "jsErrors"]) {
    if (m[k]) s[k + "Sessions"] = m[k].sessionsWith;
  }
  if (m.perfMetrics) {
    s.performanceScore = round(m.perfMetrics.score, 1);
    s.lcpMs = m.perfMetrics.lcp;
    s.inpMs = m.perfMetrics.inp;
    s.cls = m.perfMetrics.cls;
  }
  return s;
}

// Smart events come back as {item: "<id or empty>", count, extraData: ["name"]}.
function tidyMetrics(m) {
  const out = { ...m };
  if (Array.isArray(out.smartEvents)) {
    out.smartEvents = out.smartEvents.map((e) => ({
      name: Array.isArray(e.extraData) ? e.extraData[0] : e.extraData,
      id: e.item || null,
      count: e.count,
    }));
  }
  return out;
}

/**
 * @param {Array<object>} records stored records from parseCapture
 * @param {{includeHeatmaps?: boolean, includeRaw?: boolean, timeZone?: string}} opts
 */
export function buildExport(records, opts = {}) {
  const timeZone = opts.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const projects = {};
  const views = new Map();
  const proj = (id) => (projects[id] ??= { id, name: null, hostname: null, funnels: [], other: {} });

  const sorted = [...records].sort((a, b) => a.capturedAt - b.capturedAt);

  // Pass 1: project-level info (no date range).
  for (const r of sorted) {
    const d = r.data || {};
    if (r.operation === "getMembershipInfo") {
      const list = d.accountStatus?.userData?.membershipInfo?.projects || [];
      for (const p of list) {
        if (!p.project?.id) continue;
        const P = proj(p.project.id);
        P.name = p.project.friendlyName ?? P.name;
        P.hostname = p.project.hostname ?? P.hostname;
        P.isAdmin = !!p.admin;
      }
      continue;
    }
    if (r.range || !r.projectId) continue;
    const P = proj(r.projectId);
    if (r.operation === "getProjectSummary") {
      const s = d.project?.projectSummary || {};
      P.name = s.friendlyName ?? P.name;
      P.hostname = s.hostname ?? P.hostname;
    } else if (r.operation === "getFunnels") {
      P.funnels = d.project?.funnels || [];
    } else {
      P.other[r.operation] = d.project || d.projectFeatures || d;
    }
  }

  // Pass 2: data for a specific date range.
  for (const r of sorted) {
    if (!r.range || !r.projectId) continue;
    const vkey = `${r.projectId}|${r.range.from}|${r.range.to}|${r.filterSig}`;
    let v = views.get(vkey);
    if (!v) {
      const days = Math.max(1, Math.round((Date.parse(r.range.to) - Date.parse(r.range.from)) / 86400000));
      v = {
        key: fnv1a(vkey),
        projectId: r.projectId,
        from: r.range.from,
        to: r.range.to,
        fromDate: localDate(r.range.from, timeZone),
        toDate: localDate(r.range.to, timeZone),
        days,
        filters: r.extraFilters,
        summary: {},
        metrics: {},
        funnels: {},
        sessionsCount: null,
        sessions: new Map(),
        heatmaps: [],
        other: {},
        operations: new Set(),
        lastCapturedAt: 0,
      };
      views.set(vkey, v);
    }
    v.operations.add(r.operation);
    v.lastCapturedAt = Math.max(v.lastCapturedAt, r.capturedAt);
    const pf = r.data?.projectFeatures;
    if (!pf) {
      v.other[r.operation] = r.data;
      continue;
    }
    if (pf.dashboard && typeof pf.dashboard === "object") {
      const dash = { ...pf.dashboard };
      if ("funnelStepCounts" in dash || "funnelConversionTime" in dash) {
        const fid = r.variables.funnelId || "unknown";
        const f = (v.funnels[fid] ??= { funnelId: fid, stepsIds: (r.variables.stepsIds || "").split(",").filter(Boolean) });
        if ("funnelStepCounts" in dash) f.stepCounts = dash.funnelStepCounts;
        if ("funnelConversionTime" in dash) f.conversionTime = dash.funnelConversionTime;
        if ("totalSessions" in dash) f.totalSessions = dash.totalSessions;
        delete dash.funnelStepCounts;
        delete dash.funnelConversionTime;
        delete dash.totalSessions;
      }
      Object.assign(v.metrics, dash);
    }
    if (Array.isArray(pf.sessions)) {
      for (const s of pf.sessions) {
        v.sessions.set(s.id ?? `${s.userId}-${s.sessionId}`, {
          ...s,
          sessionStartIso: typeof s.sessionStart === "number" ? new Date(s.sessionStart).toISOString() : undefined,
        });
      }
    }
    if (typeof pf.sessionsCount === "number") v.sessionsCount = pf.sessionsCount;
    if (pf.heatmapPayload) {
      const h = pf.heatmapPayload;
      const entry = { url: h.url, deviceType: r.variables.deviceType ?? null, width: h.width, height: h.height };
      if (opts.includeHeatmaps) entry.sampleImpression = h.sampleImpression;
      v.heatmaps = v.heatmaps.filter((x) => !(x.url === entry.url && x.deviceType === entry.deviceType));
      v.heatmaps.push(entry);
    }
    if (pf.availableFeatures) v.other.availableFeatures = pf.availableFeatures;
  }

  // Finalize.
  const outViews = [...views.values()]
    .map((v) => {
      const P = projects[v.projectId];
      const funnelDefs = new Map((P?.funnels || []).map((f) => [f.id, f]));
      const funnels = Object.values(v.funnels).map((f) => {
        const def = funnelDefs.get(f.funnelId);
        const steps = (f.stepsIds || []).map((id, i) => {
          const sd = def?.steps?.find((s) => s.id === id);
          return { id, name: sd?.name ?? null, sessions: Array.isArray(f.stepCounts) ? f.stepCounts[i] ?? null : null };
        });
        return { funnelId: f.funnelId, name: def?.name ?? null, totalSessions: f.totalSessions ?? null, conversionTime: f.conversionTime ?? null, steps };
      });
      const metrics = tidyMetrics(v.metrics);
      const sessions = [...v.sessions.values()].sort((a, b) => (b.sessionStart ?? 0) - (a.sessionStart ?? 0));
      return {
        key: v.key,
        projectId: v.projectId,
        projectName: P?.name ?? null,
        fromDate: v.fromDate,
        toDate: v.toDate,
        days: v.days,
        from: v.from,
        to: v.to,
        filters: v.filters,
        summary: summarize(v.metrics),
        metrics,
        funnels,
        sessionsCount: v.sessionsCount,
        sessionsCaptured: sessions.length,
        sessions,
        heatmaps: v.heatmaps,
        other: v.other,
        operations: [...v.operations].sort(),
        lastCapturedAt: new Date(v.lastCapturedAt).toISOString(),
      };
    })
    .sort((a, b) => a.projectId.localeCompare(b.projectId) || b.days - a.days || a.from.localeCompare(b.from));

  for (const P of Object.values(projects)) if (!Object.keys(P.other).length) delete P.other;

  const exp = {
    format: "clarity-capture-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    timeZone,
    source: "Responses captured from the Microsoft Clarity dashboard (unofficial internal API).",
    notes: {
      newUserSessions: "Clarity's newAndReturning counts sessions by new vs returning users, so the two add up to total sessions.",
      sessions: "Recordings metadata. Only the pages of the Recordings list you opened in Clarity are captured.",
    },
    projects,
    views: outViews,
  };
  if (opts.includeRaw) exp.raw = sorted;
  return exp;
}

export function exportFilename(view, stamp = new Date()) {
  const ts = stamp.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  if (!view) return `clarity-exports/clarity_all_${ts}.json`;
  return `clarity-exports/clarity_${view.projectId}_${view.fromDate}_to_${view.toDate}_${ts}.json`;
}

// An export containing just one view (plus its project info).
export function exportForView(exp, view) {
  return { ...exp, projects: { [view.projectId]: exp.projects[view.projectId] }, views: [view] };
}

// Lightweight list for UIs (no recordings or heatmap payloads).
export function listViews(exp) {
  return exp.views.map((v) => ({
    key: v.key,
    projectId: v.projectId,
    projectName: v.projectName,
    fromDate: v.fromDate,
    toDate: v.toDate,
    days: v.days,
    filters: v.filters,
    summary: v.summary,
    sessionsCount: v.sessionsCount,
    sessionsCaptured: v.sessionsCaptured,
    heatmaps: v.heatmaps.length,
    dataTypes: Object.keys(v.metrics).length,
    operations: v.operations,
    lastCapturedAt: v.lastCapturedAt,
  }));
}
