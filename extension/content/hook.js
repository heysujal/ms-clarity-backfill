// Runs in the page's own JS world (MAIN) on clarity.microsoft.com.
// Watches the dashboard's own POST /api/v2 calls and copies each response.
// It never sends a request of its own and never changes what the page receives.
(() => {
  if (window.__clarityDataCaptureHook) return;
  window.__clarityDataCaptureHook = true;

  const MARK = "__clarityDataCapture__";
  // network: /api/v2 calls the browser actually made (Resource Timing)
  // intercepted: calls that went through our fetch/XHR wrappers
  // posted: responses handed to the extension; failed: could not be copied
  const stats = { network: 0, intercepted: 0, posted: 0, failed: 0 };

  const isApiUrl = (url) => {
    try {
      const u = new URL(url, location.href);
      return u.origin === location.origin && u.pathname.startsWith("/api/v2");
    } catch {
      return false;
    }
  };

  const post = (request, status, response) => {
    if (typeof request !== "string" || typeof response !== "string") {
      stats.failed++;
      return;
    }
    stats.posted++;
    window.postMessage({ [MARK]: true, kind: "capture", request, status, response }, location.origin);
  };

  const bodyToText = async (body) => {
    if (body == null) return null;
    if (typeof body === "string") return body;
    if (body instanceof Blob) return body.text();
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    if (body instanceof URLSearchParams) return body.toString();
    return null; // FormData / streams: not used by Clarity's GraphQL client
  };

  // --- fetch ---
  const origFetch = window.fetch;
  const patchedFetch = function (input, init) {
    let url = "";
    let method = "GET";
    let reqClone = null;
    try {
      if (typeof input === "string") url = input;
      else if (input instanceof URL) url = input.href;
      else if (input instanceof Request) {
        url = input.url;
        method = input.method;
      }
      if (init && init.method) method = init.method;
    } catch {
      /* never break the page */
    }
    const isTarget = method.toUpperCase() === "POST" && isApiUrl(url);
    if (isTarget) {
      stats.intercepted++;
      try {
        if (input instanceof Request && !(init && init.body != null)) reqClone = input.clone();
      } catch {
        /* ignore */
      }
    }

    const p = origFetch.apply(this, arguments);
    if (!isTarget) return p;

    const bodyP = init && init.body != null ? bodyToText(init.body) : reqClone ? reqClone.text() : Promise.resolve(null);
    p.then(
      (res) => {
        // Clone synchronously, before the page gets a chance to read the body.
        let copy;
        try {
          copy = res.clone();
        } catch {
          stats.failed++;
          return;
        }
        Promise.all([bodyP, copy.text()])
          .then(([body, text]) => post(body, res.status, text))
          .catch(() => stats.failed++);
      },
      () => {},
    );
    return p;
  };
  try {
    Object.defineProperty(patchedFetch, "name", { value: "fetch" });
  } catch {
    /* ignore */
  }
  window.fetch = patchedFetch;

  // --- XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ccMethod = String(method || "GET");
    this.__ccUrl = String(url || "");
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__ccMethod && this.__ccMethod.toUpperCase() === "POST" && isApiUrl(this.__ccUrl)) {
        stats.intercepted++;
        const bodyP = bodyToText(body);
        this.addEventListener("load", () => {
          let textP;
          try {
            const t = this.responseType;
            if (t === "" || t === "text") textP = Promise.resolve(this.responseText);
            else if (t === "json") textP = Promise.resolve(JSON.stringify(this.response));
            else if (t === "arraybuffer") textP = Promise.resolve(new TextDecoder().decode(this.response));
            else if (t === "blob") textP = this.response.text();
            else textP = Promise.resolve(null);
          } catch {
            textP = Promise.resolve(null);
          }
          Promise.all([bodyP, textP])
            .then(([b, text]) => post(b, this.status, text))
            .catch(() => stats.failed++);
        });
      }
    } catch {
      /* ignore */
    }
    return origSend.apply(this, arguments);
  };

  // --- diagnostics: compare with what the network actually did ---
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if ((e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest") && isApiUrl(e.name)) stats.network++;
      }
    }).observe({ type: "resource", buffered: true });
  } catch {
    /* ignore */
  }
  let lastSent = "";
  setInterval(() => {
    const s = JSON.stringify(stats);
    if (s === lastSent) return;
    lastSent = s;
    window.postMessage({ [MARK]: true, kind: "stats", stats: { ...stats } }, location.origin);
  }, 1000);
})();
