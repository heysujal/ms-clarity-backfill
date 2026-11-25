# Clarity Data Capture (Chrome extension)

Saves the data your Microsoft Clarity dashboard already loads and lets you download it as clean JSON. Unofficial and not affiliated with Microsoft.

It **sends no requests of its own**. It copies the responses of the `/api/v2` calls the dashboard makes while you use it, so Clarity sees normal browsing.

## Install

1. Open `chrome://extensions` in the Chrome profile you use for Clarity. Use the secondary account's profile.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension. Reload any Clarity tabs that were already open.
   After updating the files, click the reload icon on the extension card, then refresh Clarity tabs.

## Use

On clarity.microsoft.com, a **Capture** button sits in the bottom-right corner. Click it to open the panel:

- **Date range**: 3D / 7D / 30D / 90D / 180D / 1Y, or "Last N days" (up to 1000). Picking a range reloads the page with `?date=Last N days`, so everything Clarity loads is captured.
- **This range**: sessions, users and recordings captured, plus a checklist of Dashboard, Recordings and Heatmaps. Click one to open it with the same range.
- **Copy JSON / Download JSON** for the current range. "All captured data" copies or downloads everything.
- **Footer**: `API calls · intercepted · saved`. If it shows "missed", some Clarity requests went past the hook. Please report the numbers.

The toolbar popup lists captured ranges with Copy and JSON buttons. It also has two switches: Capture on/off, and showing or hiding the panel on Clarity.

Downloads go to `Downloads/clarity-exports/`, the folder the MCP server reads.

Each date range becomes a separate entry. Viewing the same range again updates it with the newest data.
Clarity's own date picker also works for ranges it puts in the URL. Picking from the panel is the reliable way.

## JSON format (`format: "clarity-capture-export"`, version 1)

```
{
  exportedAt, timeZone,
  projects: { <id>: { name, hostname, funnels: [...] } },
  views: [{
    projectId, projectName, fromDate, toDate, days, filters,
    summary:  { sessions, botSessions, uniqueUsers, pagesPerSession, scrollDepthPercent,
                avgTotalTimeSec, avgActiveTimeSec, deadClicksSessions, rageClicksSessions,
                quickBacksSessions, jsErrorsSessions, performanceScore, lcpMs, inpMs, cls, ... },
    metrics:  { raw Clarity dashboard fields: topPathsWithTitleAndParams, referrers,
                devices, browsers, smartEvents, topErrorsBreakdown, botTypes, perfMetrics, ... },
    funnels:  [{ name, steps: [{ name, sessions }] }],
    sessionsCount, sessionsCaptured, sessions: [...],
    heatmaps: [{ url, deviceType, width, height }]
  }]
}
```

Notes:

- `newUserSessions` + `returningUserSessions` = total sessions. Clarity counts sessions, not people.
- Account details (`getAccountStatus`) and Clarity's own telemetry are never saved.
- Data stays in this browser (`chrome.storage.local`) until you download or clear it.
