// ===== 实时字幕 Edge 扩展 - 设置页逻辑 =====

const DEFAULTS = {
  engine: "whisper",
  language: "zh",
  fontSize: "medium",
  maxLines: 2,
  bottomOffset: 60,
  opacity: 0.75,
  whisperUrl: "http://127.0.0.1:8760",
  apiKey: "",
  whisperModel: "large-v3-turbo",
  sliceInterval: 3000,
  audioInputDeviceId: "",
};

const $ = (id) => document.getElementById(id);
const els = {
  language: $("language"),
  fontSize: $("fontSize"),
  maxLines: $("maxLines"),
  bottomOffset: $("bottomOffset"),
  bottomOffsetVal: $("bottomOffset-val"),
  opacity: $("opacity"),
  opacityVal: $("opacity-val"),
  whisperUrl: $("whisperUrl"),
  apiKey: $("apiKey"),
  whisperModel: $("whisperModel"),
  sliceInterval: $("sliceInterval"),
  saveBtn: $("save-btn"),
  toast: $("toast"),
  wsDot: $("ws-dot"),
  wsText: $("ws-text"),
  checkWhisperBtn: $("check-whisper-btn"),
  audioInputDevice: $("audioInputDevice"),
  refreshAudioBtn: $("refresh-audio-btn"),
};

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  els.language.value = settings.language;
  els.fontSize.value = settings.fontSize;
  els.maxLines.value = String(settings.maxLines);
  els.bottomOffset.value = settings.bottomOffset;
  els.bottomOffsetVal.textContent = settings.bottomOffset + "px";
  els.opacity.value = settings.opacity;
  els.opacityVal.textContent = settings.opacity.toFixed(2);
  els.whisperUrl.value = settings.whisperUrl;
  els.apiKey.value = settings.apiKey;
  els.whisperModel.value = settings.whisperModel;
  els.sliceInterval.value = String(settings.sliceInterval);
  els.audioInputDevice.value = settings.audioInputDeviceId;

}


function _populateDevices(devices) {
  const audioInputs = devices.filter(d => d.kind === "audioinput");
  const select = els.audioInputDevice;
  const currentValue = select.value;
  select.innerHTML = '<option value="">自动 (默认)</option>';
  for (const device of audioInputs) {
    const label = device.label || ("设备 " + device.deviceId.slice(0, 8) + "…");
    const opt = document.createElement("option");
    opt.value = device.deviceId;
    opt.textContent = label;
    select.appendChild(opt);
  }
  if (currentValue) select.value = currentValue;
}

// 快速枚举（不弹权限框，首次加载用）
async function enumerateAudioInputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    _populateDevices(devices);
  } catch (e) {
    console.warn("[RT-Caption] 获取音频设备失败:", e.message);
  }
}

// 完整枚举（弹权限框获取标签，用户点刷新时调用）
async function refreshAudioInputs() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    _populateDevices(devices);
  } catch (e) {
    console.warn("[RT-Caption] 刷新音频设备失败:", e.message);
    enumerateAudioInputs();
  }
}

async function saveSettings() {
  try {
    const settings = {
      engine: "whisper",
      language: els.language.value,
      fontSize: els.fontSize.value,
      maxLines: parseInt(els.maxLines.value),
      bottomOffset: parseInt(els.bottomOffset.value),
      opacity: parseFloat(els.opacity.value),
      whisperUrl: els.whisperUrl.value,
      apiKey: els.apiKey.value,
      whisperModel: els.whisperModel.value,
      sliceInterval: parseInt(els.sliceInterval.value),
      audioInputDeviceId: els.audioInputDevice.value,
    };
    console.log("[RT-Caption] 保存设置:", JSON.stringify(settings));
    await chrome.storage.sync.set(settings);
    const tabs = await chrome.tabs.query({});
    console.log("[RT-Caption] 通知标签页:", tabs.length);
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "update-settings" });
      } catch (e) {}
    }
    showToast();
  } catch (e) {
    console.error("[RT-Caption] 保存失败:", e);
    alert("保存失败: " + e.message);
  }
}

async function checkWhisper() {
  els.wsDot.className = "status-dot checking";
  els.wsText.textContent = "检测中...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "check-whisper-status",
      whisperUrl: els.whisperUrl.value,
      apiKey: els.apiKey.value,
    });

    if (response && response.available) {
      els.wsDot.className = "status-dot online";
      const model = response.data.model || "未知";
      const device = response.data.device || "未知";
      const loaded = response.data.loaded ? "已加载" : "未加载";
      els.wsText.textContent = `在线 · ${model} · ${device} · ${loaded}`;
    } else {
      els.wsDot.className = "status-dot offline";
      els.wsText.textContent = response?.error || "无法连接";
    }
  } catch (e) {
    els.wsDot.className = "status-dot offline";
    els.wsText.textContent = "检测失败";
  }
}

function showToast() {
  els.toast.classList.add("show");
  setTimeout(() => els.toast.classList.remove("show"), 2000);
}

els.bottomOffset.addEventListener("input", () => {
  els.bottomOffsetVal.textContent = els.bottomOffset.value + "px";
});
els.opacity.addEventListener("input", () => {
  els.opacityVal.textContent = parseFloat(els.opacity.value).toFixed(2);
});
els.saveBtn.addEventListener("click", saveSettings);
els.checkWhisperBtn.addEventListener("click", checkWhisper);

els.refreshAudioBtn.addEventListener("click", refreshAudioInputs);

document.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  setTimeout(enumerateAudioInputs, 500);
});