// Optional live access to Clarity's internal dashboard API (POST /api/v2, GraphQL),
// using the session of a SEPARATE Microsoft account that is a member of the project.
// Unofficial: may break or be blocked. Strictly rate-limited and cached.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { clarityFilter, eachDay, stripTypename, summarize, tidySmartEvents, todayYmd } from "./util.ts";

const ENDPOINT = "https://clarity.microsoft.com/api/v2";

export class AuthError extends Error {}

// ---------- request queue (one at a time, >= minIntervalMs apart) ----------
let last = 0;
let queue: Promise<unknown> = Promise.resolve();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let requestCount = 0;

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    const wait = last + config.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait + Math.floor(Math.random() * 300));
    try {
      return await fn();
    } finally {
      last = Date.now();
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

export async function gql(operationName: string, query: string, variables: Record<string, unknown>, projectId?: string): Promise<any> {
  const creds = config.live;
  if (!creds) throw new AuthError("Live mode is not configured. Set CLARITY_COOKIE and CLARITY_CSRF_TOKEN in .env (see README).");

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await enqueue(() => {
      requestCount++;
      return fetch(ENDPOINT, {
        method: "POST",
        headers: {
          accept: "*/*",
          "content-type": "application/json",
          "csrf-token": creds.csrfToken,
          cookie: creds.cookie,
          origin: "https://clarity.microsoft.com",
          referer: `https://clarity.microsoft.com/projects/view/${projectId ?? ""}/dashboard`,
          "user-agent": config.userAgent,
          ...(creds.clarityVersion ? { "x-clarity-version": creds.clarityVersion } : {}),
        },
        body: JSON.stringify({ operationName, variables, query }),
      });
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep([5000, 15000, 30000][attempt]);
      continue;
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`Clarity rejected the session (HTTP ${res.status}). Log in again in the secondary Chrome profile and copy a fresh CLARITY_COOKIE and CLARITY_CSRF_TOKEN into .env.`);
    }
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new AuthError(`Clarity returned non-JSON (HTTP ${res.status}); the session has probably expired. Copy a fresh CLARITY_COOKIE and CLARITY_CSRF_TOKEN into .env.`);
    }
    if (res.status !== 200) throw new Error(`Clarity HTTP ${res.status}: ${text.slice(0, 300)}`);
    const errs: any[] = Array.isArray(body.errors) ? body.errors : [];
    if (errs.some((e) => /auth|login|unauthor|forbidden|csrf/i.test(String(e.message)))) {
      throw new AuthError(`Clarity auth error: ${errs.map((e) => e.message).join("; ")}. Copy a fresh CLARITY_COOKIE and CLARITY_CSRF_TOKEN into .env.`);
    }
    return { data: stripTypename(body.data), errors: errs.map((e) => String(e.message)) };
  }
  throw new Error("Clarity kept returning 429/5xx; stopped after 3 attempts. Try again later.");
}

export const liveRequestCount = () => requestCount;

// ---------- dashboard sections ----------
const ARGS = "filters: $filters, isAppProject: false, includePageQualityIssuesSessions: false";
const ARGS_NO_APP = "filters: $filters, includePageQualityIssuesSessions: false";
const ARGS_ALL = "filters: $filters, isAppProject: false, fetchAll: true, includePageQualityIssuesSessions: false";
const BLOCK = "pages sessionsWith sessionsWithout subTotal";

export const SECTIONS = {
  overview: (_n: number) => `dashboard(${ARGS}) { sessions { totalSessions totalBotSessions } pagesPerSession scrollDepth totalUsers engagement { totalTime activeTime } }`,
  newReturning: (_n: number) => `dashboard(${ARGS_NO_APP}) { newAndReturning { returningUsers newUsers } }`,
  performance: (_n: number) => `dashboard(${ARGS_NO_APP}) { perfMetrics { pageViews goodViews poorViews improveViews score lcp cls inp } }`,
  insights: (_n: number) => `dashboard(${ARGS}) { rageClicks { ${BLOCK} } deadClicks { ${BLOCK} } excessiveScrolls { ${BLOCK} } quickBacks { ${BLOCK} } jsErrors { ${BLOCK} } }`,
  errors: (_n: number) => `dashboard(${ARGS}) { topErrorsBreakdown(skip: 0) { errorText errorCount } botTypes { webScraperBotSessions suspiciousDeviceBotSessions suspiciousNetworkBotSessions suspiciousInteractionBotSessions ppcAdFraudBotSessions otherBotsSessions } }`,
  pages: (n: number) => `dashboard(${ARGS}) { topPathsWithTitleAndParams(skip: 0, limit: ${n}) { item count pageTitle } }`,
  referrers: (n: number) => `dashboard(${ARGS}) { referrers(skip: 0, limit: ${n}) { item count } }`,
  topUsers: (n: number) => `dashboard(${ARGS}) { topUsers(skip: 0, limit: ${n}, isSortAscending: false) { item count userCountry userDevice } }`,
  devicesBrowsers: (_n: number) => `dashboard(${ARGS_ALL}) { browsers { item count } devices { item count } }`,
  smartEvents: (_n: number) => `dashboard(${ARGS}) { smartEvents { item count extraData } }`,
} as const;

export type Section = keyof typeof SECTIONS;
export const ALL_SECTIONS = Object.keys(SECTIONS) as Section[];
export const DAILY_SECTIONS: Section[] = ["overview", "newReturning", "insights", "performance"];

function wrap(name: string, fields: string, filtersType = "String") {
  return `query ${name}($projectId: String!, $filters: ${filtersType}) {\n  projectFeatures(id: $projectId) {\n    id\n    ${fields}\n  }\n}\n`;
}

/** One request for all sections (GraphQL aliases); falls back to one request per section on errors. */
export async function fetchSections(projectId: string, from: string, to: string, sections: Section[], limit = 20) {
  const filters = clarityFilter(from, to);
  const vars = { projectId, filters };
  const combined = wrap("getDashboardSections", sections.map((s) => `${s}: ${SECTIONS[s](limit)}`).join("\n    "));
  const metrics: Record<string, any> = {};
  const errors: string[] = [];

  const absorb = (pf: any) => {
    for (const s of sections) if (pf?.[s]) Object.assign(metrics, pf[s]);
  };

  const r = await gql("getDashboardSections", combined, vars, projectId);
  if (!r.errors.length && r.data?.projectFeatures) {
    absorb(r.data.projectFeatures);
  } else {
    for (const s of sections) {
      const one = await gql("getDashboardSections", wrap("getDashboardSections", `${s}: ${SECTIONS[s](limit)}`), vars, projectId);
      if (one.errors.length) errors.push(`${s}: ${one.errors.join("; ")}`);
      absorb(one.data?.projectFeatures);
    }
  }
  if (metrics.smartEvents) metrics.smartEvents = tidySmartEvents(metrics.smartEvents);
  return { summary: summarize(metrics), metrics, errors };
}

// ---------- per-day history with disk cache ----------
function cachePath(projectId: string, day: string, sig: string) {
  return path.join(config.cacheDir, projectId, `${day}.${sig}.json`);
}

export async function fetchDaily(projectId: string, from: string, to: string, sections: Section[], maxRequests: number) {
  const sig = [...sections].sort().join("+");
  const today = todayYmd();
  const days = eachDay(from, to);
  const rows: Array<Record<string, unknown>> = [];
  let fetched = 0;
  let cached = 0;
  const missing: string[] = [];
  const errors: string[] = [];

  for (const day of days) {
    const p = cachePath(projectId, day, sig);
    if (day < today && fs.existsSync(p)) {
      rows.push(JSON.parse(fs.readFileSync(p, "utf8")));
      cached++;
      continue;
    }
    if (fetched >= maxRequests) {
      missing.push(day);
      continue;
    }
    const r = await fetchSections(projectId, day, day, sections);
    fetched++;
    const row = { date: day, ...r.summary };
    if (r.errors.length) errors.push(`${day}: ${r.errors.join(" | ")}`);
    else if (day < today) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(row));
    }
    rows.push(row);
  }
  return { rows, fetched, cached, missing, errors };
}

// ---------- projects, sessions, funnels ----------
const MEMBERSHIP = `query getMembershipInfo($offset: Int) {
  accountStatus { userData { id membershipInfo(offset: $offset) { hasMore projects { admin project { id hostname friendlyName isAppProject } } } } }
}`;

export async function listProjects() {
  const out: any[] = [];
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    const r = await gql("getMembershipInfo", MEMBERSHIP, { offset });
    const mi = r.data?.accountStatus?.userData?.membershipInfo;
    const list = mi?.projects || [];
    for (const p of list) out.push({ id: p.project.id, name: p.project.friendlyName, hostname: p.project.hostname, isAdmin: p.admin, isAppProject: p.project.isAppProject });
    if (!mi?.hasMore || !list.length) break;
    offset += list.length;
  }
  return out;
}

const SESSIONS = `query getSessions($projectId: String!, $limit: Int, $filter: String, $sort: String, $skip: Int, $withFavorites: Boolean, $withTags: Boolean, $isAppProject: Boolean, $includeIncompleteSessions: Boolean, $includePageQualityIssuesSessions: Boolean) {
  projectFeatures(id: $projectId) {
    id
    sessions(serializedFilter: $filter, sortClause: $sort, skip: $skip, limit: $limit, withFavorites: $withFavorites, withTags: $withTags, isAppProject: $isAppProject, includeIncompleteSessions: $includeIncompleteSessions, includePageQualityIssuesSessions: $includePageQualityIssuesSessions) {
      id userId sessionId sessionStart sessionDuration entryUrl exitUrl referrer browserName device os pageCount sessionClickCount country state city tags entryScreen exitScreen osVersion deviceModel customUserId customSessionId viewPortWidth viewPortHeight userIntent
    }
  }
}`;

export async function listSessions(projectId: string, from: string, to: string, limit: number) {
  const filter = clarityFilter(from, to);
  const out: any[] = [];
  for (let skip = 0; out.length < limit; skip += 100) {
    const r = await gql(
      "getSessions",
      SESSIONS,
      { projectId, filter, sort: null, limit: 100, skip, withFavorites: false, withTags: true, isAppProject: false, includeIncompleteSessions: false, includePageQualityIssuesSessions: false },
      projectId,
    );
    if (r.errors.length) throw new Error(r.errors.join("; "));
    const page: any[] = r.data?.projectFeatures?.sessions || [];
    for (const s of page) out.push({ ...s, sessionStartIso: typeof s.sessionStart === "number" ? new Date(s.sessionStart).toISOString() : undefined });
    if (page.length < 100) break;
  }
  return out.slice(0, limit);
}

const FUNNELS = `query getFunnels($projectId: String!, $includePageQualityIssuesSessions: Boolean) {
  project(id: $projectId) { id funnels(includePageQualityIssuesSessions: $includePageQualityIssuesSessions) { id name definedBy steps { id stepType name details { eventId urlPattern } } } }
}`;

export async function funnels(projectId: string, from: string, to: string) {
  const defs = await gql("getFunnels", FUNNELS, { projectId, includePageQualityIssuesSessions: false }, projectId);
  const list: any[] = defs.data?.project?.funnels || [];
  if (!list.length) return [];
  const lit = (s: string) => JSON.stringify(s);
  const field = (f: any, i: number) => {
    const steps = lit(f.steps.map((s: any) => s.id).join(","));
    return `f${i}: dashboard(${ARGS}) { funnelStepCounts(funnelId: ${lit(f.id)}, stepsIds: ${steps}, isAppProject: false) funnelConversionTime(funnelId: ${lit(f.id)}, stepsIds: ${steps}, isAppProject: false) totalSessions }`;
  };
  const vars = { projectId, filters: clarityFilter(from, to) };
  const results: any[] = [];
  const r = await gql("getFunnelStepCounts", wrap("getFunnelStepCounts", list.map(field).join("\n    "), "String!"), vars, projectId);
  const pf = r.errors.length ? null : r.data?.projectFeatures;
  for (let i = 0; i < list.length; i++) {
    let d = pf?.[`f${i}`];
    if (!d) {
      const one = await gql("getFunnelStepCounts", wrap("getFunnelStepCounts", field(list[i], i), "String!"), vars, projectId);
      d = one.data?.projectFeatures?.[`f${i}`];
    }
    const f = list[i];
    results.push({
      id: f.id,
      name: f.name,
      totalSessions: d?.totalSessions ?? null,
      conversionTime: d?.funnelConversionTime ?? null,
      steps: f.steps.map((s: any, j: number) => ({ name: s.name, type: s.stepType, sessions: Array.isArray(d?.funnelStepCounts) ? d.funnelStepCounts[j] ?? null : null })),
    });
  }
  return results;
}
