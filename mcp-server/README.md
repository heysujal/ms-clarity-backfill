# Clarity MCP server

An MCP server for Microsoft Clarity with two data sources. Unofficial and not affiliated with Microsoft.

| Mode | Source | Network | Tools |
|---|---|---|---|
| **Captured** (always on) | JSON files downloaded by the Chrome extension | none | `clarity_status`, `clarity_list_captured`, `clarity_get_captured`, `clarity_search_captured_recordings` |
| **Live** (optional) | Clarity's internal dashboard API, using a secondary account's session | ≤ 1 request/sec | `clarity_live_projects`, `clarity_live_dashboard`, `clarity_live_daily`, `clarity_live_recordings`, `clarity_live_funnels` |

Requires Node ≥ 23.6. It runs TypeScript directly, with no build step.

## Setup

```bash
cd mcp-server
npm install
```

Add it to Claude Code:

```bash
claude mcp add clarity -- node "$(pwd)/src/index.ts"   # run from mcp-server/
```

Config goes in `../.env` (see `../.env.example`).

## Live mode (optional)

Live mode uses unofficial endpoints. Set `CLARITY_COOKIE` and `CLARITY_CSRF_TOKEN` in `../.env` from a **separate Microsoft account** that's a Member of the project. The [root README](../README.md#live-mode-get-the-cookie-and-csrf-token) has step-by-step instructions.

When the session expires, tools return `AUTH: ...`. Copy fresh values into `.env` and restart the server.

Built-in safeguards:

- One request at a time, at least 1 second apart (`CLARITY_MIN_INTERVAL_MS`, minimum 1000).
- Each dashboard range uses one GraphQL request (sections are combined with aliases).
- `clarity_live_daily` caches past days in `~/.clarity-mcp/cache` and never fetches them again. It caps each call at `maxRequests` (default 60). Call it again to continue.
- Backs off on HTTP 429/5xx and stops after 3 attempts.
