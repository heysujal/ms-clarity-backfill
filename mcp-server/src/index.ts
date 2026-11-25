import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "./config.ts";
import { describeFilter, findViews, loadCaptured } from "./exports.ts";
import { ALL_SECTIONS, AuthError, DAILY_SECTIONS, fetchDaily, fetchSections, funnels, listProjects, listSessions, liveRequestCount, type Section } from "./live.ts";
import { assertYmd, daysAgo, json, todayYmd } from "./util.ts";

const server = new McpServer({ name: "clarity", version: "0.1.0" });

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const LIVE = { readOnlyHint: true, openWorldHint: true } as const;

const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof AuthError ? `AUTH: ${e.message}` : `Error: ${(e as Error).message}` }],
});

function projectOrDefault(p?: string) {
  const id = p || config.defaultProject;
  if (!id) throw new Error("projectId is required (or set CLARITY_DEFAULT_PROJECT). Use clarity_list_captured or clarity_live_projects to find it.");
  return id;
}

// ------------------------------------------------------------------ status
server.registerTool(
  "clarity_status",
  {
    title: "Clarity MCP status",
    description: "Shows where captured exports are read from, what has been captured, and whether live mode is configured.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  async () => {
    const { files, views, projects } = loadCaptured();
    return json({
      exportDir: config.exportDir,
      exportFiles: files.length,
      capturedViews: views.length,
      projects: Object.values(projects).map((p) => ({ id: p.id, name: p.name })),
      live: config.live
        ? { configured: true, minIntervalMs: config.minIntervalMs, requestsThisRun: liveRequestCount(), cacheDir: config.cacheDir }
        : { configured: false, how: "Set CLARITY_COOKIE and CLARITY_CSRF_TOKEN in .env from the SECONDARY account's Clarity session (see README: 'Live mode: get the cookie and CSRF token')." },
      timeZone: config.timeZone,
      today: todayYmd(),
    });
  },
);

// ------------------------------------------------------------------ captured (offline)
server.registerTool(
  "clarity_list_captured",
  {
    title: "List captured Clarity data",
    description:
      "Lists the date ranges captured by the Chrome extension (offline, no network). Each view is one project + date range (+ optional filter such as a URL for heatmaps).",
    inputSchema: { projectId: z.string().optional(), includeFiltered: z.boolean().default(false).describe("Also list URL-filtered views (heatmaps)") },
    annotations: READ_ONLY,
  },
  async ({ projectId, includeFiltered }) =>
    json(
      findViews({ projectId, includeFiltered }).map((v) => ({
        projectId: v.projectId,
        projectName: v.projectName,
        fromDate: v.fromDate,
        toDate: v.toDate,
        days: v.days,
        filters: v.filters.map(describeFilter),
        sessions: v.summary.sessions ?? null,
        dataTypes: Object.keys(v.metrics),
        recordingsCaptured: v.sessionsCaptured,
        heatmaps: v.heatmaps.map((h) => h.url),
        capturedAt: v.lastCapturedAt,
        file: v.file,
      })),
    ),
);

server.registerTool(
  "clarity_get_captured",
  {
    title: "Get captured Clarity metrics",
    description:
      "Returns the summary and all metrics (top pages, referrers, devices, browsers, smart events, errors, funnels...) for a captured date range. Without dates, returns the longest captured range. Offline.",
    inputSchema: {
      projectId: z.string().optional(),
      fromDate: ymd.optional(),
      toDate: ymd.optional(),
      recordingsLimit: z.number().int().min(0).max(1000).default(0).describe("How many captured recordings (session metadata) to include"),
    },
    annotations: READ_ONLY,
  },
  async ({ projectId, fromDate, toDate, recordingsLimit }) => {
    const v = findViews({ projectId: projectId || config.defaultProject || undefined, fromDate, toDate })[0];
    if (!v) return fail(new Error("No captured view matches. Call clarity_list_captured to see what exists."));
    const { sessions, ...rest } = v;
    return json({ ...rest, sessions: sessions.slice(0, recordingsLimit) });
  },
);

server.registerTool(
  "clarity_search_captured_recordings",
  {
    title: "Search captured recordings",
    description: "Filters captured recordings (session metadata from the Recordings list) by country, device, browser, entry/exit URL or referrer. Offline.",
    inputSchema: {
      projectId: z.string().optional(),
      country: z.string().optional(),
      device: z.string().optional().describe("Mobile, PC, Tablet"),
      browser: z.string().optional(),
      urlContains: z.string().optional().describe("Matches entry or exit URL"),
      referrerContains: z.string().optional(),
      minPages: z.number().int().optional(),
      limit: z.number().int().min(1).max(500).default(50),
    },
    annotations: READ_ONLY,
  },
  async (q) => {
    const has = (a: unknown, b?: string) => !b || String(a ?? "").toLowerCase().includes(b.toLowerCase());
    const seen = new Set<string>();
    const out: any[] = [];
    for (const v of findViews({ projectId: q.projectId, includeFiltered: true })) {
      for (const s of v.sessions) {
        const id = String(s.id ?? `${s.userId}-${s.sessionId}`);
        if (seen.has(id)) continue;
        seen.add(id);
        if (!has(s.country, q.country) || !has(s.device, q.device) || !has(s.browserName, q.browser)) continue;
        if (q.urlContains && !has(s.entryUrl, q.urlContains) && !has(s.exitUrl, q.urlContains)) continue;
        if (!has(s.referrer, q.referrerContains)) continue;
        if (q.minPages && (s.pageCount ?? 0) < q.minPages) continue;
        out.push(s);
      }
    }
    out.sort((a, b) => (b.sessionStart ?? 0) - (a.sessionStart ?? 0));
    return json({ matched: out.length, recordings: out.slice(0, q.limit) });
  },
);

// ------------------------------------------------------------------ live (optional)
if (config.live) {
  server.registerTool(
    "clarity_live_projects",
    {
      title: "List Clarity projects (live)",
      description: "Lists the Clarity projects the configured (secondary) account can see. Makes 1 request.",
      inputSchema: {},
      annotations: LIVE,
    },
    async () => {
      try {
        return json(await listProjects());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "clarity_live_dashboard",
    {
      title: "Clarity dashboard for any date range (live)",
      description:
        "Fetches dashboard metrics for ANY date range (not limited to 3 days). Usually 1 request. Sections: " + ALL_SECTIONS.join(", "),
      inputSchema: {
        projectId: z.string().optional(),
        from: ymd.describe("Start date, YYYY-MM-DD (local time zone)"),
        to: ymd.optional().describe("End date, defaults to today"),
        sections: z.array(z.enum(ALL_SECTIONS as [Section, ...Section[]])).optional().describe("Defaults to all"),
        topN: z.number().int().min(1).max(100).default(20).describe("Rows for top pages / referrers / users"),
      },
      annotations: LIVE,
    },
    async ({ projectId, from, to, sections, topN }) => {
      try {
        const pid = projectOrDefault(projectId);
        const end = to || todayYmd();
        const r = await fetchSections(pid, from, end, sections?.length ? sections : ALL_SECTIONS, topN);
        return json({ projectId: pid, from, to: end, ...r });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "clarity_live_daily",
    {
      title: "Per-day Clarity history (live, cached)",
      description:
        "Per-day metrics (sessions, users, engagement, scroll, dead/rage clicks, errors, performance) for a date range. ~1 request per uncached day at >=1/sec; past days are cached on disk and never refetched. If 'missing' is non-empty, call again to continue.",
      inputSchema: {
        projectId: z.string().optional(),
        from: ymd.optional().describe("Defaults to 30 days ago"),
        to: ymd.optional().describe("Defaults to today"),
        maxRequests: z.number().int().min(1).max(120).default(60).describe("Cap on new requests in this call"),
      },
      annotations: LIVE,
    },
    async ({ projectId, from, to, maxRequests }) => {
      try {
        const pid = projectOrDefault(projectId);
        const start = from || daysAgo(30);
        const end = to || todayYmd();
        assertYmd(start, "from");
        assertYmd(end, "to");
        const r = await fetchDaily(pid, start, end, DAILY_SECTIONS, maxRequests);
        return json({ projectId: pid, from: start, to: end, ...r, note: r.missing.length ? `Stopped after ${maxRequests} requests; call again to fetch the remaining ${r.missing.length} days.` : undefined });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "clarity_live_recordings",
    {
      title: "List recordings (live)",
      description: "Lists recorded sessions (metadata: entry/exit URL, referrer, device, country, duration, pages) for a date range. 1 request per 100 recordings.",
      inputSchema: {
        projectId: z.string().optional(),
        from: ymd.optional().describe("Defaults to 7 days ago"),
        to: ymd.optional(),
        limit: z.number().int().min(1).max(2000).default(100),
      },
      annotations: LIVE,
    },
    async ({ projectId, from, to, limit }) => {
      try {
        const pid = projectOrDefault(projectId);
        const rows = await listSessions(pid, from || daysAgo(7), to || todayYmd(), limit);
        return json({ count: rows.length, recordings: rows });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "clarity_live_funnels",
    {
      title: "Funnels (live)",
      description: "All funnels with per-step session counts for a date range. Usually 2 requests.",
      inputSchema: { projectId: z.string().optional(), from: ymd, to: ymd.optional() },
      annotations: LIVE,
    },
    async ({ projectId, from, to }) => {
      try {
        const pid = projectOrDefault(projectId);
        return json(await funnels(pid, from, to || todayYmd()));
      } catch (e) {
        return fail(e);
      }
    },
  );
}

await server.connect(new StdioServerTransport());
console.error(`[clarity-mcp] ready. exports: ${config.exportDir} · live: ${config.live ? "on" : "off"}`);
