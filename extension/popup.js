const dot = document.getElementById("dot");
const conn = document.getElementById("conn");
const statusBox = document.getElementById("status");
const agentDot = document.getElementById("agent-dot");
const agentText = document.getElementById("agent");
const toggle = document.getElementById("toggle");
const clear = document.getElementById("clear");
const error = document.getElementById("error");
const list = document.getElementById("list");
const empty = document.getElementById("empty");
const heading = document.getElementById("heading");

let tabId = null;
let capturing = false;

async function currentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, never innerHTML: paths and hosts come from whatever site the
  // user was browsing, so treating them as markup would be an XSS hole.
  if (text != null) node.textContent = text;
  return node;
}

function renderList(endpoints) {
  list.textContent = "";
  heading.textContent = endpoints.length
    ? `Endpoints (${endpoints.length})`
    : "Endpoints";
  empty.style.display = endpoints.length ? "none" : "";

  for (const ep of endpoints) {
    const row = el("div", "ep");
    const top = el("div", "ep-top");
    top.append(el("span", "verb", ep.method), el("span", "path", ep.pathTemplate));
    if (ep.requiresAuth) top.append(el("span", "lock", "AUTH"));
    top.append(el("span", "count", `x${ep.seenCount}`));
    row.append(top, el("div", "host", ep.origin.replace(/^https?:\/\//, "")));
    list.append(row);
  }
}

function render({ connected, capturing: isCapturing, endpoints = [], agent = null }) {
  capturing = isCapturing;
  dot.classList.toggle("on", connected);
  conn.textContent = connected ? "Bridge connected" : "Bridge offline";
  statusBox.classList.toggle("offline", !connected);
  agentDot.classList.toggle("on", !!agent);
  agentText.textContent = !connected
    ? "Agent unknown"
    : agent
      ? `Agent: ${[agent.name, agent.version].filter(Boolean).join(" ")}`
      : "No agent attached";
  toggle.textContent = isCapturing ? "Stop capturing" : "Start capturing";
  toggle.classList.toggle("active", isCapturing);
  renderList(endpoints);
}

async function refresh() {
  render(await chrome.runtime.sendMessage({ type: "get-status", tabId }));
}

toggle.addEventListener("click", async () => {
  error.textContent = "";
  const res = await chrome.runtime.sendMessage({ type: capturing ? "stop" : "start", tabId });
  if (!res.ok) {
    // Usually means DevTools already holds the debugger on this tab.
    error.textContent = res.error;
    return;
  }
  render(res);
});

clear.addEventListener("click", async () => {
  error.textContent = "";
  const res = await chrome.runtime.sendMessage({ type: "clear" });
  if (!res.ok) error.textContent = "Not connected to the bridge.";
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status-changed") refresh();
});

(async () => {
  tabId = await currentTabId();
  await refresh();
})();
