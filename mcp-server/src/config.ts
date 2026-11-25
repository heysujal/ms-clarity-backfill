import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");

// Load .env from mcp-server/ first, then the repo root. Existing env vars win.
for (const p of [path.join(serverRoot, ".env"), path.join(serverRoot, "..", ".env")]) {
  try {
    if (fs.existsSync(p)) process.loadEnvFile(p);
  } catch (e) {
    console.error(`[clarity-mcp] could not read ${p}: ${(e as Error).message}`);
  }
}

const expandHome = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

export interface LiveCredentials {
  cookie: string;
  csrfToken: string;
  clarityVersion?: string;
}

/** Pull cookie / csrf-token / x-clarity-version out of Chrome's "Copy as cURL (bash)". */
export function parseCurl(text: string): Partial<LiveCredentials> {
  const out: Partial<LiveCredentials> = {};
  const quoted = String.raw`\$?'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;
  const unq = (m: RegExpExecArray) => (m[1] ?? m[2] ?? "").replace(/\\'/g, "'");
  const headerRe = new RegExp(String.raw`(?:-H|--header)\s+(?:${quoted})`, "g");
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(text))) {
    const h = unq(m);
    const i = h.indexOf(":");
    if (i < 0) continue;
    const name = h.slice(0, i).trim().toLowerCase();
    const value = h.slice(i + 1).trim();
    if (name === "cookie") out.cookie = value;
    else if (name === "csrf-token") out.csrfToken = value;
    else if (name === "x-clarity-version") out.clarityVersion = value;
  }
  const cookieRe = new RegExp(String.raw`(?:-b|--cookie)\s+(?:${quoted})`);
  const c = cookieRe.exec(text);
  if (c) out.cookie = unq(c);
  return out;
}

function loadLive(): LiveCredentials | null {
  let creds: Partial<LiveCredentials> = {};
  const curlFile = process.env.CLARITY_CURL_FILE;
  if (curlFile) {
    const p = path.resolve(serverRoot, "..", expandHome(curlFile));
    try {
      creds = parseCurl(fs.readFileSync(p, "utf8"));
    } catch (e) {
      console.error(`[clarity-mcp] CLARITY_CURL_FILE unreadable (${p}): ${(e as Error).message}`);
    }
  }
  if (process.env.CLARITY_COOKIE) creds.cookie = process.env.CLARITY_COOKIE;
  if (process.env.CLARITY_CSRF_TOKEN) creds.csrfToken = process.env.CLARITY_CSRF_TOKEN;
  if (process.env.CLARITY_VERSION) creds.clarityVersion = process.env.CLARITY_VERSION;
  if (!creds.cookie || !creds.csrfToken) return null;
  return creds as LiveCredentials;
}

export const config = {
  exportDir: path.resolve(expandHome(process.env.CLARITY_EXPORT_DIR || "~/Downloads/clarity-exports")),
  cacheDir: path.resolve(expandHome(process.env.CLARITY_CACHE_DIR || "~/.clarity-mcp/cache")),
  defaultProject: process.env.CLARITY_DEFAULT_PROJECT || null,
  // Never faster than 1 request/second, whatever the env says.
  minIntervalMs: Math.max(1000, Number(process.env.CLARITY_MIN_INTERVAL_MS) || 1200),
  userAgent:
    process.env.CLARITY_USER_AGENT ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  live: loadLive(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};
