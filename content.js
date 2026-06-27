// ===== 实时字幕 Edge 扩展 - content script v4.1 =====
// 从页面 <video> 捕获音频 → ScriptProcessorNode → PCM WAV → Whisper 服务
console.log("[RT-Caption] content script loaded");

// ---- 工具: 获取设置 ----
function getSettings() {
  return chrome.storage.sync.get({
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
  });
}

// ---- WAV 编码器: Float32Array → WAV ArrayBuffer ----
function encodeWAV(samples, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = samples.length * blockAlign;
  const bufferSize = 44 + dataSize;

  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, bufferSize - 8, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(offset, s, true);
    offset += 2;
  }
  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ---- 音量检测 (RMS) ----
function computeRMS(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

// ---- 实时音频捕获 ----
class VideoAudioCapture {
  constructor() {
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.sourceVideo = null;
    this.onPCM = null;
    this.onVideoTime = null;
    this.timePollInterval = null;
    this.isCapturing = false;
    this._captureSource = null;
    this._captureGain = null;
  }

  async start(videoElement, onPCM, onVideoTime, deviceId = "") {
    if (this.isCapturing) return;
    this.onPCM = onPCM;
    this.onVideoTime = onVideoTime;
    this.sourceVideo = videoElement;

    this.timePollInterval = setInterval(() => {
      if (this.sourceVideo && !this.sourceVideo.paused && this.onVideoTime) {
        this.onVideoTime(this.sourceVideo.currentTime);
      }
    }, 200);

    // 先尝试 getUserMedia（用户可在浏览器弹窗中选择 Voicemeeter 等虚拟设备）
    // 这种方式不会静音 video，所以有声音
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioContext.state === "suspended") await this.audioContext.resume();
      console.log("[RT-Caption] 请求系统音频...");
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          }
        });
      } catch (firstErr) {
        // 不降级到基础约束（会误抓麦克风音频），直接回退到 captureStream
        console.warn("[RT-Caption] 高级约束失败 (", firstErr.name, ":", firstErr.message, ")，回退到 video 捕获");
        throw firstErr;
      }
      console.log("[RT-Caption] 系统音频获取成功, 轨道:", stream.getAudioTracks().length);
      const track = stream.getAudioTracks()[0];
      console.log("[RT-Caption] 音频设备:", track.label);
      this._captureStream = stream;
      this._captureSource = this.audioContext.createMediaStreamSource(stream);
      this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.processorNode.onaudioprocess = (event) => {
        if (!this.isCapturing) return;
        const input = event.inputBuffer.getChannelData(0);
        if (input && input.length > 0 && this.onPCM) {
          this.onPCM(input, this.audioContext.sampleRate);
        }
      };
      this._captureSource.connect(this.processorNode);
      // 输出端接零音量 GainNode 作为假负载，防止浏览器优化掉 ScriptProcessor
      this._captureGain = this.audioContext.createGain();
      this._captureGain.gain.value = 0;
      this.processorNode.connect(this._captureGain);
      this._captureGain.connect(this.audioContext.destination);
      this.isCapturing = true;
      console.log("[RT-Caption] 系统音频捕获启动, 采样率:", this.audioContext.sampleRate);
      return true;
    } catch (e) {
      if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") {
        console.warn("[RT-Caption] 用户拒绝了麦克风权限，不回退到 video 捕获");
        this.stop();
        throw new Error("麦克风权限被拒绝");
      }
      // 方案A失败，关闭已创建的 AudioContext 避免泄漏
      if (this.audioContext) {
        try { this.audioContext.close(); this.audioContext = null; } catch (e) {}
      }
      console.warn("[RT-Caption] 系统音频不可用 (", e.name, ":", e.message, ")", "- 回退到 video 捕获");
    }

    // 方案 B: 尝试 videoElement.captureStream()（不静音、不需虚拟设备）
    try {
      if (videoElement.captureStream) {
        console.log("[RT-Caption] 尝试 video.captureStream...");
        const videoStream = videoElement.captureStream();
        const audioTracks = videoStream.getAudioTracks();
        if (audioTracks.length > 0) {
          this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
          if (this.audioContext.state === "suspended") await this.audioContext.resume();
          this._captureSource = this.audioContext.createMediaStreamSource(videoStream);
          this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
          this.processorNode.onaudioprocess = (event) => {
            if (!this.isCapturing) return;
            const input = event.inputBuffer.getChannelData(0);
            if (input && input.length > 0 && this.onPCM) {
              this.onPCM(input, this.audioContext.sampleRate);
            }
          };
          this._captureSource.connect(this.processorNode);
          this._captureGain = this.audioContext.createGain();
          this._captureGain.gain.value = 0;
          this.processorNode.connect(this._captureGain);
          this._captureGain.connect(this.audioContext.destination);
          this.isCapturing = true;
          console.log("[RT-Caption] video.captureStream 音频捕获启动, 采样率:", this.audioContext.sampleRate);
          return true;
        }
      }
    } catch (e) {
      console.warn("[RT-Caption] captureStream 不可用:", e.message);
    }

    // 方案 C: createMediaElementSource 捕获 video 音频（会静音 video）
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }
      this.sourceNode = this.audioContext.createMediaElementSource(videoElement);
      this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.processorNode.onaudioprocess = (event) => {
        if (!this.isCapturing) return;
        const input = event.inputBuffer.getChannelData(0);
        if (input && input.length > 0 && this.onPCM) {
          this.onPCM(input, this.audioContext.sampleRate);
        }
      };
      this.sourceNode.connect(this.processorNode);
      try { this.sourceNode.connect(this.audioContext.destination); } catch(e) {}
      this.isCapturing = true;
      console.log("[RT-Caption] video 音频捕获启动, 采样率:", this.audioContext.sampleRate);
      return true;
    } catch (e) {
      console.error("[RT-Caption] video 音频不可用:", e.message.slice(0, 60));
      this.stop();
      throw e;
    }
  }

  stop() {
    this.isCapturing = false;
    if (this.timePollInterval) {
      clearInterval(this.timePollInterval);
      this.timePollInterval = null;
    }
    try {
      if (this.processorNode) {
        this.processorNode.disconnect();
        this.processorNode = null;
      }
      if (this._captureStream) {
        this._captureStream.getTracks().forEach(t => t.stop());
        this._captureStream = null;
      }
      if (this._captureSource) {
        try { this._captureSource.disconnect(); } catch(e) {}
        this._captureSource = null;
      }
      if (this._captureGain) {
        try { this._captureGain.disconnect(); } catch(e) {}
        this._captureGain = null;
      }
      if (this.audioContext) {
        this.audioContext.close().catch(() => {});
        this.audioContext = null;
      }
    } catch (e) {
      console.warn("[RT-Caption] 清理音频资源:", e);
    }
    console.log("[RT-Caption] 音频捕获已停止");
  }
}

// ---- Whisper 客户端 ----
class WhisperClient {
  constructor(onResult, onError) {
    this.onResult = onResult;
    this.onError = onError;
    this.running = false;
    this.whisperUrl = "";
    this.apiKey = "";
    this.sliceInterval = 3000;
    this.sliceTimer = null;
    this.lastSendTime = 0;
    this.accumulatedSamples = [];
  }

  start(url, key, interval, language) {
    this.language = language || "auto";
    this.whisperUrl = url;
    this.apiKey = key;
    this.sliceInterval = interval || 3000;
    this.running = true;
    this.accumulatedSamples = [];
    this.lastSendTime = Date.now();

    this.sliceTimer = setInterval(() => this._doSlice(), this.sliceInterval);
    console.log("[RT-Caption] Whisper 客户端已启动");
  }

  feedPCM(samples, sampleRate) {
    if (!this.running) return;
    const resampled = this._resample(samples, sampleRate, 16000);
    this.accumulatedSamples.push(...resampled);
  }

  _resample(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    const ratio = fromRate / toRate;
    const outputLength = Math.round(input.length / ratio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const idx = i * ratio;
      const idx0 = Math.floor(idx);
      const idx1 = Math.min(idx0 + 1, input.length - 1);
      const frac = idx - idx0;
      output[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
    }
    return output;
  }

  _doSlice() {
    if (!this.running) return;
    const accLen = this.accumulatedSamples.length;
    if (accLen < 1600) return;

    const samples = this.accumulatedSamples;
    this.accumulatedSamples = [];

    const rms = computeRMS(samples);
    if (rms < 0.005) return;

    this._sendChunk(samples);
  }

  async _sendChunk(samples) {
    const wavBuffer = encodeWAV(samples, 16000);
    const blob = new Blob([wavBuffer], { type: "audio/wav" });

    const formData = new FormData();
    formData.append("audio", blob, "audio.wav");
    const lang = this.language || "auto";
    if (lang !== "auto") formData.append("language", lang);

    const headers = {};
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;

    try {
      const base = this.whisperUrl.replace(/\/+$/, "");
      const resp = await fetch(`${base}/asr`, {
        method: "POST",
        headers,
        body: formData,
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.warn(`[RT-Caption] Whisper 错误 ${resp.status}: ${text.slice(0, 100)}`);
        if (this.onError) this.onError(`服务错误: ${resp.status}`);
        return;
      }

      const data = await resp.json();
      console.log("[RT-Caption] Whisper response received, segments:", data.segments?.length, "text:", data.text?.slice(0,30));
      if (data.segments && data.segments.length > 0) {
        if (this.onResult) this.onResult(data.segments);
      }
    } catch (e) {
      console.warn("[RT-Caption] Whisper 请求失败:", e.message);
      if (this.onError) this.onError(e.message);
    }
  }

  flush() {
    if (this.accumulatedSamples.length > 0) {
      const samples = this.accumulatedSamples;
      this.accumulatedSamples = [];
      const rms = computeRMS(samples);
      if (rms >= 0.005 && samples.length >= 1600) {
        this._sendChunk(samples);
      }
    }
  }

  stop() {
    this.running = false;
    this.flush();
    if (this.sliceTimer) {
      clearInterval(this.sliceTimer);
      this.sliceTimer = null;
    }
    console.log("[RT-Caption] Whisper 客户端已停止");
  }
}

// ---- 字幕时间轴管理器 ----
class CaptionTimeline {
  constructor() {
    this.segments = [];
    this.nextId = 0;
  }

  addSegments(newSegments) {
    for (const seg of newSegments) {
      if (!seg.text || !seg.text.trim()) continue;
      if (this.segments.length > 0) {
        const last = this.segments[this.segments.length - 1];
        if (this._textOverlap(last.text, seg.text) > 0.7 && Math.abs(seg.start - last.start) < 5) continue;
      }
      this.segments.push({
        id: this.nextId++,
        text: seg.text.trim(),
        start: seg.start,
        end: seg.end,
      });
    }
  }

  getActiveAtTime(currentTimeSec) {
    const active = [];
    for (const seg of this.segments) {
      if (currentTimeSec >= seg.start - 0.3 && currentTimeSec < seg.end + 0.5) {
        active.push(seg);
      }
    }
    active.sort((a, b) => a.start - b.start);
    return active;
  }

  cleanOld(currentTimeSec) {
    this.segments = this.segments.filter(s => s.end > currentTimeSec - 60);
  }

  _textOverlap(a, b) {
    if (!a || !b) return 0;
    const short = a.length < b.length ? a : b;
    const long = a.length < b.length ? b : a;
    let matches = 0;
    for (const ch of short) {
      if (long.includes(ch)) matches++;
    }
    return matches / short.length;
  }
}

// ---- 语音积累器 ----
class SpeechAccumulator {
  constructor(gapThreshold = 2.0) {
    this.buffer = [];
    this.gapThreshold = gapThreshold;
    this.lastEndTime = 0;
  }

  add(segments) {
    for (const seg of segments) {
      if (!seg.text || !seg.text.trim()) continue;
      const gap = seg.start - this.lastEndTime;
      if (gap > this.gapThreshold && this.buffer.length > 0) {
        this.buffer = [];
      }
      this.buffer.push(seg);
      this.lastEndTime = seg.end || seg.start;
    }
  }

  getCurrentText() {
    return this.buffer.map(s => s.text).join(" ");
  }

  reset() {
    this.buffer = [];
    this.lastEndTime = 0;
  }
}

// ---- 字幕 UI 管理器 ----
class CaptionManager {
  constructor() {
    this.isActive = false;
    this.videoCapture = null;
    this.whisperClient = null;
    this.timeline = new CaptionTimeline();
    this.accumulator = new SpeechAccumulator(2.0);
    this.videoCurrentTime = 0;
    this.settings = null;
    this.displayTimer = null;
    this._lastCaptionHtml = "";
    this.container = null;
    this.captionsEl = null;
    this.indicator = null;
    this.engineLabel = null;
    this.currentVideo = null;
    this.hintEl = null;
  }

  async init() {
    this.createUI();
    this._listenMessages();
    // 不自动启动，让用户点击字幕控制条来开关
    // 同时检测 video 供后续使用
    setTimeout(() => this._detectVideo(), 2000);
  }

  createUI() {
    this.container = document.createElement("div");
    this.container.id = "rt-caption-container";
    this.container.className = "rt-hidden";
    this.container.innerHTML = `
      <div id="rt-caption-bar">
        <div id="rt-caption-status">
          <span id="rt-indicator" class="rt-idle"></span>
          <span id="rt-engine-label"></span>
        </div>
        <span id="rt-caption-close" title="关闭字幕">×</span>
      </div>
      <div id="rt-captions"></div>
    `;

    document.body.appendChild(this.container);
    this.captionsEl = this.container.querySelector("#rt-captions");
    this.indicator = this.container.querySelector("#rt-indicator");
    this.engineLabel = this.container.querySelector("#rt-engine-label");

    const closeBtn = this.container.querySelector("#rt-caption-close");
    closeBtn.addEventListener("click", () => this.stop());
    
    // 点击字幕状态条切换开关
    const statusBar = this.container.querySelector("#rt-caption-bar");
    statusBar.addEventListener("click", (e) => {
      if (e.target === closeBtn) return;
      this.isActive ? this.stop() : this.start();
    });

    // 拖动字幕位置
    let dragging = false, dragStartY = 0, dragStartBottom = 0;
    statusBar.addEventListener("mousedown", (e) => {
      if (e.target === closeBtn) return;
      dragging = true;
      dragStartY = e.clientY;
      dragStartBottom = parseInt(getComputedStyle(this.container).bottom) || 60;
      this.container.style.transition = "none";
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const deltaY = dragStartY - e.clientY;
      const newBottom = Math.max(0, Math.min(window.innerHeight - 80, dragStartBottom + deltaY));
      this.container.style.bottom = newBottom + "px";
    });
    document.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        this.container.style.transition = "opacity 0.3s ease, bottom 0.2s ease";
      }
    });
  }

  _detectVideo() {
    // 检测页面中的 video 元素，保存引用供后续使用
    const video = this._findBestVideo();
    if (video) {
      this.currentVideo = video;
      console.log("[RT-Caption] 检测到 video，等待点击启动");
      this._showHint();
      return;
    }
    // 用 MutationObserver 监控
    let debounceTimer = null;
    // Observer 60秒超时（声明在回调之前，避免 TDZ 问题）
    const observerTimeout = setTimeout(() => {
      observer.disconnect();
      if (debounceTimer) clearTimeout(debounceTimer);
      console.log("[RT-Caption] 60秒内未检测到 video，停止 MutationObserver");
    }, 60000);

    const observer = new MutationObserver(() => {
      if (this.currentVideo && this.currentVideo.duration) {
        observer.disconnect();
        clearTimeout(observerTimeout);
        return;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const v = this._findBestVideo();
        if (v) {
          this.currentVideo = v;
          console.log("[RT-Caption] 检测到 video，等待点击启动");
          this._showHint();
          observer.disconnect();
          clearTimeout(observerTimeout);
        }
      }, 1000);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 轮询兜底，60秒超时（20次 × 3秒）
    let pollCount = 0;
    const pollTimer = setInterval(() => {
      if (this.currentVideo && this.currentVideo.duration) { clearInterval(pollTimer); clearTimeout(observerTimeout); return; }
      const v = this._findBestVideo();
      if (v) {
        this.currentVideo = v;
        this._showHint();
        clearInterval(pollTimer);
        clearTimeout(observerTimeout);
        return;
      }
      pollCount++;
      if (pollCount >= 20) { clearInterval(pollTimer); console.log("[RT-Caption] 轮询超时，停止检测 video"); }
    }, 3000);
  }
  
  _setIndicator(state) {
    if (!this.indicator) return;
    this.indicator.className = `rt-${state}`;
  }

  _showHint() {
    if (this.isActive || this.hintEl) return;
    this.hintEl = document.createElement("div");
    this.hintEl.id = "rt-caption-hint";
    this.hintEl.textContent = "🎬 字幕";
    Object.assign(this.hintEl.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      zIndex: "2147483646",
      background: "rgba(26,115,232,0.9)",
      color: "#ffffff",
      padding: "10px 20px",
      borderRadius: "24px",
      cursor: "pointer",
      fontSize: "15px",
      fontWeight: "600",
      fontFamily: '"Microsoft YaHei","PingFang SC",sans-serif',
      pointerEvents: "auto !important",
      boxShadow: "0 4px 14px rgba(26,115,232,0.4)",
      transition: "transform 0.15s, box-shadow 0.15s",
      userSelect: "none",
    });
    // 阻止 SHPlayer 等页面脚本截获点击
    this.hintEl.addEventListener("mousedown", (e) => { e.stopPropagation(); e.stopImmediatePropagation(); }, true);
    this.hintEl.addEventListener("mouseup",   (e) => { e.stopPropagation(); e.stopImmediatePropagation(); }, true);
    this.hintEl.addEventListener("click",     (e) => { e.stopPropagation(); e.stopImmediatePropagation(); console.log("[RT-Caption] 启动按钮被点击"); this.start(); }, true);
    this.hintEl.addEventListener("mouseenter", () => {
      this.hintEl.style.transform = "scale(1.06)";
      this.hintEl.style.boxShadow = "0 6px 20px rgba(26,115,232,0.55)";
    });
    this.hintEl.addEventListener("mouseleave", () => {
      this.hintEl.style.transform = "scale(1)";
      this.hintEl.style.boxShadow = "0 4px 14px rgba(26,115,232,0.4)";
    });
    document.body.appendChild(this.hintEl);
    console.log("[RT-Caption] 显示启动提示按钮");
  }

  _hideHint() {
    if (this.hintEl) {
      this.hintEl.remove();
      this.hintEl = null;
    }
  }

  _listenMessages() {
    const that = this;
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === "toggle") {
        that.isActive ? that.stop() : that.start();
        try { sendResponse({ active: that.isActive }); } catch (e) {}
      } else if (msg.type === "stop") {
        that.stop();
        try { sendResponse({ active: false }); } catch (e) {}
      } else if (msg.type === "update-settings") {
        getSettings().then(s => {
          const old = that.settings;
          that.settings = s;
          that._applySettings();
          if (that.isActive) {
            const needsRestart = !old ||
              old.whisperUrl !== s.whisperUrl ||
              old.apiKey !== s.apiKey ||
              old.language !== s.language ||
              old.sliceInterval !== s.sliceInterval ||
              old.audioInputDeviceId !== s.audioInputDeviceId;
            if (needsRestart) {
              that.stop();
              setTimeout(() => that.start(), 500);
            } else {
              console.log("[RT-Caption] 仅外观设置变更，跳过重启");
            }
          }
        });
        try { sendResponse({ ok: true }); } catch (e) {}
      } else if (msg.type === "whisper-result" && msg.segments) {
        that._onWhisperResult(msg.segments);
        try { sendResponse({ ok: true }); } catch (e) {}
      } else if (msg.type === "whisper-error") {
        console.warn("[RT-Caption] Whisper 错误:", msg.error);
        that._setIndicator("error");
        setTimeout(() => { if (that.isActive) { that._setIndicator("listening"); } }, 3000);
        try { sendResponse({ ok: true }); } catch (e) {}
      }

      return true;
    });
  }

  _applySettings() {
    if (!this.container || !this.settings) return;
    this.container.style.setProperty("--rt-opacity", this.settings.opacity || 0.75);
    this.container.style.setProperty("--rt-bottom", (this.settings.bottomOffset || 60) + "px");
  }

  _findBestVideo() {
    // 简单直接: 查询所有 video 元素
    let allVideos;
    try {
      allVideos = Array.from(document.querySelectorAll("video"));
    } catch (e) {
      return null;
    }

    if (allVideos.length === 0) {
      // 试试 Shadow DOM
      try {
        const hosts = document.querySelectorAll("*");
        for (const host of hosts) {
          if (host.shadowRoot) {
            const sv = host.shadowRoot.querySelectorAll("video");
            if (sv.length > 0) allVideos = allVideos.concat(Array.from(sv));
          }
        }
      } catch (e) {}
    }

    if (allVideos.length === 0) return null;
    console.log("[RT-Caption] 找到 video:", allVideos.length);

    // 优先选正在播放的
    let best = allVideos.find(v => !v.paused);
    if (best) return best;

    // fallback: 第一个
    return allVideos[0];
  }

  _waitForVideo(timeout = 30000) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const check = () => {
        const v = this._findBestVideo();
        if (v) { resolve(v); return; }
        if (Date.now() - startTime > timeout) { resolve(null); return; }
        setTimeout(check, 1000);
      };
      setTimeout(check, 1000);
    });
  }

  async start() {
    if (this.isActive) return;
    this.isActive = true;  // 立即标记，防止 _showHint 重复创建按钮
    this._hideHint();

    this.settings = await getSettings();
    this._applySettings();

    let video = this.currentVideo;
    if (!video || !video.duration) {
      video = await this._waitForVideo(10000);
    }
    // 等待期间用户可能已关闭字幕
    if (!this.isActive) {
      return;
    }
    if (!video) {
      console.warn("[RT-Caption] 未找到视频，无法启动");
      this._setIndicator("error");
      this.isActive = false;
      this._showHint();
      return;
    }
    this.currentVideo = video;

    this.container.classList.remove("rt-hidden");
    this._setIndicator("connecting");
    this.engineLabel.textContent = "Whisper";

    this.whisperClient = new WhisperClient(
      (segments) => this._onWhisperResult(segments),
      (err) => {
        console.warn("[RT-Caption] Whisper 错误:", err);
        this._setIndicator("error");
        setTimeout(() => { if (this.isActive) this._setIndicator("listening"); }, 3000);
      }
    );
    this.whisperClient.start(
      this.settings.whisperUrl,
      this.settings.apiKey,
      this.settings.sliceInterval,
      this.settings.language
    );

    this.videoCapture = new VideoAudioCapture();
    try {
      await this.videoCapture.start(
        video,
        (samples, sampleRate) => {
          if (this.whisperClient && this.isActive) {
            this.whisperClient.feedPCM(samples, sampleRate);
          }
          // 实时音量驱动 indicator 透明度
          if (this.indicator && this.isActive && samples.length > 0) {
            let sum = 0;
            for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
            const rms = Math.sqrt(sum / samples.length);
            const alpha = Math.min(1, rms * 40);
            this.indicator.style.opacity = 0.3 + alpha * 0.7;
          }
        },
        (currentTime) => {
          this.videoCurrentTime = currentTime;
        },
        this.settings.audioInputDeviceId
      );
    } catch (e) {
      console.error("[RT-Caption] 音频捕获失败:", e.message);
      this.whisperClient.stop();
      this.whisperClient = null;
      this._setIndicator("error");
      this.isActive = false;
      this.container.classList.add("rt-hidden");
      return;
    }

    this._setIndicator("listening");

    this.displayTimer = setInterval(() => this._updateDisplay(), 250);

    chrome.runtime.sendMessage({ type: "set-state", active: true }).catch(() => {});
    console.log("[RT-Caption] 字幕已启动");
  }

  stop() {
    if (!this.isActive) return;
    this.isActive = false;
    this._hideHint();

    if (this.videoCapture) {
      this.videoCapture.stop();
      this.videoCapture = null;
    }
    if (this.whisperClient) {
      this.whisperClient.stop();
      this.whisperClient = null;
    }
    if (this.displayTimer) {
      clearInterval(this.displayTimer);
      this.displayTimer = null;
    }

    this.container.classList.add("rt-hidden");
    this._setIndicator("idle");
    this.captionsEl.innerHTML = "";
    this._lastCaptionHtml = "";
    this.timeline = new CaptionTimeline();
    this.accumulator = new SpeechAccumulator(2.0);

    chrome.runtime.sendMessage({ type: "set-state", active: false }).catch(() => {});
    console.log("[RT-Caption] 字幕已停止");
    if (this.currentVideo) this._showHint();
  }

  _onWhisperResult(segments) {
    if (!this.isActive || !segments || segments.length === 0) return;
    // 过滤噪音识别：跳过纯数字/单字符的虚假识别结果
    const meaningful = segments.filter(s => {
      const t = s.text.trim();
      if (!t) return false;
      // 纯数字和标点（不是真实语音）
      if (/^[\d\s.,!?;:，。！？；：、\-—…·'"@#$%^&*()\[\]{}|\\/~`+=]+$/.test(t)) return false;
      // 单个字符通常是噪音
      if (t.length <= 1) return false;
      return true;
    });
    if (meaningful.length === 0) return;
    // 将 segments 时间偏移到视频时间线（Whisper 返回的是切片内相对时间）
    const sliceStart = this.videoCurrentTime - (this.settings?.sliceInterval || 3000) / 1000;
    const offsetSegments = meaningful.map(s => ({
      ...s,
      start: sliceStart + s.start,
      end: sliceStart + s.end,
    }));
    this.timeline.addSegments(offsetSegments);
    this.accumulator.reset();     // 清空上一批字幕，防止新旧文本混杂
    this.accumulator.add(offsetSegments);
    this._lastCaptionHtml = "";  // 强制刷新，确保新内容立即上屏
    this._updateDisplay();
  }

  _updateDisplay() {
    if (!this.isActive || !this.captionsEl) return;

    const MAX_CHARS = 50;
    let lines = [];

    if (this.videoCurrentTime > 0) {
      const activeSegs = this.timeline.getActiveAtTime(this.videoCurrentTime);
      if (activeSegs.length > 0) {
        lines = activeSegs.map(s => s.text);
      }
    }

    if (lines.length === 0) {
      const text = this.accumulator.getCurrentText();
      if (text) lines = [text];
    }

    // 截断过长文本
    lines = lines.map(text => text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "…" : text);

    const maxLines = this.settings?.maxLines || 2;
    if (lines.length > maxLines) {
      lines = lines.slice(-maxLines);
    }

    const sizeClass = this.settings?.fontSize === "small" ? "rt-size-small"
      : this.settings?.fontSize === "large" ? "rt-size-large"
      : "rt-size-medium";

    const newHtml = lines.length > 0
      ? lines.map(text => `<div class="rt-caption-line ${sizeClass}">${this._escapeHtml(text)}</div>`).join("")
      : "";
    if (newHtml === this._lastCaptionHtml) return;
    this._lastCaptionHtml = newHtml;
    this.captionsEl.innerHTML = newHtml;

    this.timeline.cleanOld(this.videoCurrentTime);
  }

  _escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}

// ---- 启动 ----
if (window.__RT_CAPTION_INSTANCE__) {
  console.log("[RT-Caption] 已有实例运行，跳过");
} else {
  try {
    const manager = new CaptionManager();
    manager.init();
    window.__RT_CAPTION_INSTANCE__ = manager;
    console.log("[RT-Caption] 扩展已初始化");
  } catch (e) {
    console.error("[RT-Caption] 初始化失败:", e);
  }
}