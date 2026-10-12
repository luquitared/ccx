// Funnel events go to the Odapt control plane (text/plain JSON: no CORS preflight).
// session_id is an anonymous per-browser id, so uniques can be counted; nothing else identifies anyone.
(function () {
  const EVENTS = "https://api.odapt.ai/events";
  let vid = null;
  try { vid = localStorage.getItem("ccx-vid"); if (!vid) localStorage.setItem("ccx-vid", vid = crypto.randomUUID()); } catch {}
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname);
  window.track = function (type, props) {
    if (local) return console.debug("[track]", type, props || {});
    try {
      const body = JSON.stringify({ app: "ccx", type, session_id: vid, props: props || {} });
      if (!(navigator.sendBeacon && navigator.sendBeacon(EVENTS, new Blob([body], { type: "text/plain" })))) {
        fetch(EVENTS, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain" } }).catch(() => {});
      }
    } catch {}
  };
})();
