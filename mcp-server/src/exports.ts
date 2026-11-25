// Reads the JSON files downloaded by the Clarity Data Capture extension.
// No network access.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

export interface CapturedView {
  projectId: string;
  projectName: string | null;
  fromDate: string;
  toDate: string;
  days: number;
  from: string;
  to: string;
  filters: any[];
  summary: Record<string, unknown>;
  metrics: Record<string, any>;
  funnels: any[];
  sessionsCount: number | null;
  sessionsCaptured: number;
  sessions: any[];
  heatmaps: any[];
  lastCapturedAt: string;
  file?: string;
}

interface ExportFile {
  format: string;
  exportedAt: string;
  projects: Record<string, { id: string; name: string | null; hostname: string | null; funnels?: any[] }>;
  views: CapturedView[];
}

let cache: { stamp: string; views: CapturedView[]; projects: ExportFile["projects"]; files: string[] } | null = null;

function listFiles(): string[] {
  const files: string[] = [];
  if (fs.existsSync(config.exportDir)) {
    for (const f of fs.readdirSync(config.exportDir)) if (f.endsWith(".json")) files.push(path.join(config.exportDir, f));
  }
  // Fallback downloads from the in-page panel land in the parent folder (e.g. ~/Downloads).
  const parent = path.dirname(config.exportDir);
  if (fs.existsSync(parent)) {
    for (const f of fs.readdirSync(parent)) if (/^clarity_.*\.json$/.test(f)) files.push(path.join(parent, f));
  }
  return files;
}

const viewKey = (v: CapturedView) => `${v.projectId}|${v.from}|${v.to}|${JSON.stringify(v.filters)}`;

/** Merge every export file; for the same view, the most recently captured one wins (sessions are unioned). */
export function loadCaptured() {
  const files = listFiles();
  const stamp = files.map((f) => `${f}:${fs.statSync(f).mtimeMs}`).join("|");
  if (cache && cache.stamp === stamp) return cache;

  const views = new Map<string, CapturedView>();
  const projects: ExportFile["projects"] = {};
  for (const file of files) {
    let data: ExportFile;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (data?.format !== "clarity-capture-export" || !Array.isArray(data.views)) continue;
    for (const [id, p] of Object.entries(data.projects || {})) {
      projects[id] = { ...projects[id], ...Object.fromEntries(Object.entries(p).filter(([, v]) => v != null)) } as any;
    }
    for (const v of data.views) {
      const k = viewKey(v);
      const prev = views.get(k);
      const withFile = { ...v, file: path.basename(file) };
      if (!prev) {
        views.set(k, withFile);
        continue;
      }
      const newer = Date.parse(v.lastCapturedAt) >= Date.parse(prev.lastCapturedAt) ? withFile : prev;
      const older = newer === prev ? withFile : prev;
      const sessions = new Map<string, any>();
      for (const s of [...older.sessions, ...newer.sessions]) sessions.set(String(s.id ?? `${s.userId}-${s.sessionId}`), s);
      views.set(k, {
        ...older,
        ...newer,
        metrics: { ...older.metrics, ...newer.metrics },
        summary: { ...older.summary, ...newer.summary },
        sessions: [...sessions.values()],
        sessionsCaptured: sessions.size,
      });
    }
  }
  cache = { stamp, views: [...views.values()], projects, files };
  return cache;
}

export function findViews(q: { projectId?: string; fromDate?: string; toDate?: string; includeFiltered?: boolean }) {
  const { views } = loadCaptured();
  return views
    .filter((v) => !q.projectId || v.projectId === q.projectId)
    .filter((v) => !q.fromDate || v.fromDate === q.fromDate)
    .filter((v) => !q.toDate || v.toDate === q.toDate)
    .filter((v) => q.includeFiltered || v.filters.length === 0)
    .sort((a, b) => b.days - a.days || b.lastCapturedAt.localeCompare(a.lastCapturedAt));
}

export function describeFilter(f: any) {
  const v = typeof f.value === "object" ? JSON.stringify(f.value) : String(f.value);
  return `${f.invert ? "NOT " : ""}${f.field} ${f.operator} ${v}`;
}
