import { loadExport, downloadJson, copyJson, kb, exportFilename, singleViewExport, clearAll, fmt, el, viewTitle, viewKind } from "../ui/common.js";

const $ = (id) => document.getElementById(id);
const toast = (msg) => {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 1800);
};

async function render() {
  const { enabled = true, showPanel = true } = await chrome.storage.local.get(["enabled", "showPanel"]);
  $("enabled").checked = enabled;
  $("showPanel").checked = showPanel;
  $("dot").classList.toggle("on", enabled);

  const exp = await loadExport();
  const dash = exp.views.filter((v) => viewKind(v) !== "heatmap");
  const heat = exp.views.length - dash.length;
  $("downloadAll").disabled = $("copyAll").disabled = !exp.views.length;

  const box = $("views");
  box.replaceChildren();
  if (!exp.views.length) {
    box.append(
      el("div", { class: "card empty", style: "margin:4px 0" },
        el("p", { style: "font-weight:500;color:var(--text)" }, enabled ? "Nothing captured yet" : "Capture is off"),
        el("p", { class: "small muted", style: "margin-top:6px" },
          "Open clarity.microsoft.com and pick a range in the Capture panel (bottom right). Whatever Clarity loads is saved here."),
      ),
    );
    return;
  }

  for (const v of dash.slice(0, 5)) {
    const s = v.summary;
    const name = exp.projects[v.projectId]?.name || v.projectId;
    const one = () => singleViewExport(exp, v);
    box.append(
      el("div", { class: "view row" },
        el("div", { style: "min-width:0;flex:1" },
          el("h2", {}, viewTitle(v)),
          el("p", { class: "small muted" },
            `${name} · ${v.days}d`,
            s.sessions != null ? ` · ${fmt.n(s.sessions)} sessions` : "",
            v.sessionsCaptured ? ` · ${fmt.n(v.sessionsCaptured)} recordings` : ""),
        ),
        el("button", { class: "sm", onclick: async () => toast(`Copied ${kb(await copyJson(one()))}`) }, "Copy"),
        el("button", {
          class: "sm",
          onclick: async () => {
            await downloadJson(one(), exportFilename(v));
            toast("Saved to Downloads/clarity-exports");
          },
        }, "JSON"),
      ),
    );
  }
  const more = dash.length - 5;
  if (more > 0 || heat) {
    box.append(el("p", { class: "small muted", style: "padding-top:8px" },
      [more > 0 ? `+${more} more range${more > 1 ? "s" : ""}` : "", heat ? `${heat} heatmap view${heat > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · "),
      " in the full view"));
  }
}

$("enabled").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  render();
});
$("showPanel").addEventListener("change", (e) => chrome.storage.local.set({ showPanel: e.target.checked }));
$("copyAll").addEventListener("click", async () => toast(`Copied ${kb(await copyJson(await loadExport()))}`));
$("downloadAll").addEventListener("click", async () => {
  await downloadJson(await loadExport(), exportFilename(null));
  toast("Saved to Downloads/clarity-exports");
});
$("openViewer").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("viewer/viewer.html") }));
$("clear").addEventListener("click", async () => {
  if (!confirm("Delete all captured Clarity data from this browser?")) return;
  await clearAll();
  render();
});

render();
