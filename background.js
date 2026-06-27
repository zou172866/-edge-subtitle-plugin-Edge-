// ===== 实时字幕 Edge 扩展 - Service Worker (v3) =====

const STORAGE_KEY = "extensionActive";

async function getActiveState() {
  const result = await chrome.storage.session.get({ [STORAGE_KEY]: false });
  return result[STORAGE_KEY];
}

async function setActiveState(active) {
  await chrome.storage.session.set({ [STORAGE_KEY]: active });
  updateIcon(active);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function sendToContent(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    console.warn("[RT-Caption] sendToContent 失败:", e.message);
    return null;
  }
}

async function toggleCaption() {
  const tab = await getActiveTab();
  if (!tab) return;
  const response = await sendToContent(tab.id, { type: "toggle" });
  if (response) {
    await setActiveState(response.active);
  }
}

function updateIcon(active) {
  if (active) {
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#4caf50" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

chrome.action.onClicked.addListener(() => { toggleCaption(); });


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "set-state") {
    setActiveState(msg.active)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "get-state") {
    getActiveState()
      .then(active => sendResponse({ active }))
      .catch(() => sendResponse({ active: false }));
    return true;
  }
  if (msg.type === "check-whisper-status") {
    (async () => {
      try {
        const headers = {};
        if (msg.apiKey) headers["X-API-Key"] = msg.apiKey;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const resp = await fetch(`${msg.whisperUrl}/health`, { headers, signal: ctrl.signal });
        clearTimeout(timer);
        if (resp.ok) {
          const data = await resp.json();
          sendResponse({ available: true, data });
        } else {
          sendResponse({ available: false, error: `HTTP ${resp.status}` });
        }
      } catch (e) {
        sendResponse({ available: false, error: e.message });
      }
    })();
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
  updateIcon(false);
});

console.log("[RT-Caption] Background service worker started (v3)");