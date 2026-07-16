// Attaches the Chrome debugger to a tab, collects XHR/fetch calls off the
// Network domain, and streams them to the local bridge as `capture` messages.
// The wire format is defined by server/src/types.ts.

const EXTENSION_VERSION = "0.1.0";
const WS_URL = "ws://localhost:8787";
const DEBUGGER_VERSION = "1.3";
const RECONNECT_MS = 3000;
const MAX_BODY_BYTES = 500_000;

// Only these resource types are worth capturing; everything else is page chrome.
const CAPTURED_TYPES = new Set(["XHR", "Fetch"]);

/** tabId -> true, for every tab we currently hold a debugger attachment on. */
const attached = new Map();

/** `${tabId}:${requestId}` -> partial capture, awaiting its response body. */
const inflight = new Map();

let socket = null;
let reconnectTimer = null;

// --- bridge socket ----------------------------------------------------------

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  socket = new WebSocket(WS_URL);

  socket.addEventListener("open", () => {
    console.log("[api-scraper] bridge connected");
    send({ type: "hello", extensionVersion: EXTENSION_VERSION });
    broadcastStatus();
  });

  socket.addEventListener("close", () => {
    broadcastStatus();
    scheduleReconnect();
  });

  // An error is always followed by close; let close drive the retry.
  socket.addEventListener("error", () => {});
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

// --- debugger attach / detach ----------------------------------------------

async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  attached.set(tabId, true);
  broadcastStatus();
}

async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  for (const key of inflight.keys()) {
    if (key.startsWith(`${tabId}:`)) inflight.delete(key);
  }
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already gone (tab closed, or DevTools took over) — nothing to clean up.
  }
  broadcastStatus();
}

// Chrome detaches us on tab close, navigation crashes, or when DevTools opens.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null && attached.delete(source.tabId)) broadcastStatus();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
});

// --- network events ---------------------------------------------------------

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null || !attached.has(tabId)) return;
  const key = `${tabId}:${params.requestId}`;

  switch (method) {
    case "Network.requestWillBeSent": {
      if (!CAPTURED_TYPES.has(params.type)) return;
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      inflight.set(key, {
        url: params.request.url,
        method: params.request.method,
        requestHeaders: lowerKeys(params.request.headers),
        requestBody: params.request.postData,
        tabUrl: tab?.url,
        timestamp: Date.now(),
      });
      return;
    }

    // Carries the headers actually put on the wire — cookies and auth headers
    // are absent from requestWillBeSent.
    case "Network.requestWillBeSentExtraInfo": {
      const pending = inflight.get(key);
      if (!pending) return;
      pending.requestHeaders = { ...pending.requestHeaders, ...lowerKeys(params.headers) };
      return;
    }

    case "Network.responseReceived": {
      const pending = inflight.get(key);
      if (!pending) return;
      pending.status = params.response.status;
      pending.responseContentType = params.response.mimeType;
      return;
    }

    case "Network.loadingFinished": {
      const pending = inflight.get(key);
      if (!pending) return;
      inflight.delete(key);
      pending.responseBody = await readBody(tabId, params.requestId);
      send({ type: "capture", data: pending });
      return;
    }

    case "Network.loadingFailed": {
      inflight.delete(key);
      return;
    }
  }
});

async function readBody(tabId, requestId) {
  try {
    const res = await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId });
    if (!res || res.base64Encoded) return undefined; // binary — not worth schema-inferring
    return res.body?.length > MAX_BODY_BYTES ? undefined : res.body;
  } catch {
    // Body already evicted from the debugger's buffer.
    return undefined;
  }
}

function lowerKeys(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = String(v);
  return out;
}

// --- popup messaging --------------------------------------------------------

function status(tabId) {
  return {
    connected: socket?.readyState === WebSocket.OPEN,
    capturing: attached.has(tabId),
  };
}

function broadcastStatus() {
  // The popup may be closed; a missing receiver is expected, not an error.
  chrome.runtime.sendMessage({ type: "status-changed" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "get-status":
        sendResponse(status(msg.tabId));
        return;
      case "start":
        try {
          await attach(msg.tabId);
          sendResponse({ ok: true, ...status(msg.tabId) });
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message ?? err) });
        }
        return;
      case "stop":
        await detach(msg.tabId);
        sendResponse({ ok: true, ...status(msg.tabId) });
        return;
      case "clear":
        sendResponse({ ok: send({ type: "clear" }) });
        return;
    }
  })();
  return true; // keep the channel open for the async sendResponse
});

connect();
