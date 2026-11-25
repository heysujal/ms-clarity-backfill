export function stripTypename<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripTypename) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) if (k !== "__typename") out[k] = stripTypename(val);
    return out as T;
  }
  return v;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function assertYmd(s: string, name: string) {
  if (!YMD.test(s)) throw new Error(`${name} must be YYYY-MM-DD, got "${s}"`);
}

/** Start/end of a local calendar day (process time zone), as ISO strings in UTC. */
export function dayBounds(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d, 23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function rangeBounds(from: string, to: string) {
  assertYmd(from, "from");
  assertYmd(to, "to");
  if (from > to) throw new Error(`from (${from}) is after to (${to})`);
  return { min: dayBounds(from).start, max: dayBounds(to).end };
}

export function todayYmd() {
  const d = new Date();
  return ymdOf(d);
}

export function ymdOf(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const [y, m, d] = from.split("-").map(Number);
  const cur = new Date(y, m - 1, d);
  while (true) {
    const s = ymdOf(cur);
    if (s > to) break;
    out.push(s);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymdOf(d);
}

/** Clarity's own filter format: date range + "pageDuration > 0" (what the dashboard sends). */
export function clarityFilter(from: string, to: string, extra: object[] = []) {
  const { min, max } = rangeBounds(from, to);
  return JSON.stringify({
    operator: "And",
    filters: [
      { field: "minEnqueuedTimestamp", dataType: "Number", operator: "Range", value: { min, max } },
      { field: "pageDuration", dataType: "Number", operator: "Greater", value: 0 },
      ...extra,
    ],
  });
}

const round = (n: unknown, d = 2) => (typeof n === "number" ? Math.round(n * 10 ** d) / 10 ** d : n);

/** Friendly flat summary from Clarity dashboard fields (same shape as the extension's export). */
export function summarize(m: any) {
  const s: Record<string, unknown> = {};
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

export function tidySmartEvents(list: any[] | undefined) {
  if (!Array.isArray(list)) return list;
  return list.map((e) => ({ name: Array.isArray(e.extraData) ? e.extraData[0] : e.extraData, id: e.item || null, count: e.count }));
}

export const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
