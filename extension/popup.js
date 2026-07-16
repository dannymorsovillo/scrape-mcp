const dot = document.getElementById("dot");
const conn = document.getElementById("conn");
const toggle = document.getElementById("toggle");
const clear = document.getElementById("clear");
const error = document.getElementById("error");

let tabId = null;
let capturing = false;

async function currentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function render({ connected, capturing: isCapturing }) {
  capturing = isCapturing;
  dot.classList.toggle("on", connected);
  conn.textContent = connected ? "Bridge connected" : "Bridge offline";
  toggle.textContent = isCapturing ? "Stop capturing" : "Start capturing";
  toggle.classList.toggle("active", isCapturing);
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
