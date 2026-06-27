# 🎬 实时中文字幕 - Edge 扩展

为 **网页 HTML5 视频** 添加实时中文字幕。基于本地 faster-whisper 服务捕获视频音频流进行 GPU 语音识别。

基于 [VideoCaptioner](https://github.com/WEIFENG2333/VideoCaptioner) 项目思路开发。


## ⚡ 快速开始

1. 安装依赖：`pip install faster-whisper fastapi uvicorn nvidia-cublas-cu12`
2. 双击 `start_server.bat` 启动 Whisper 服务
3. Edge 打开 `edge://extensions`，开启"开发人员模式"，加载本项目目录
4. 打开任意视频网页，点右下角「🎬 字幕」




## 功能

- 🎬 **视频音频捕获**：自动检测 `<video>` 元素，三级降级策略（getUserMedia → captureStream → createMediaElementSource）
- 🧠 **Whisper 本地识别**：faster-whisper + CTranslate2 GPU 推理，RTX 显卡加速
- 🎨 **字幕样式**：半透明背景、大字、底部居中
- 🖱️ **可拖动**：拖拽控制栏上下调整字幕位置
- 📊 **实时音量指示**：indicator 随音量闪烁
- 🔒 **安全**：服务仅监听 127.0.0.1，可选 API 密钥验证

## 工作原理

```
网页 <video> → AudioContext/CaptureStream 捕获音频
       ↓
  每 3 秒切片 → PCM → WAV
       ↓
  发送到本地 Whisper 服务 (127.0.0.1:8760)
       ↓
  faster-whisper GPU 识别 (CTranslate2)
       ↓
  返回文字 → 显示在底部字幕条
```

## 安装

### 1. 加载扩展

1. 打开 Edge 浏览器，进入 `edge://extensions`
2. 开启 **"开发人员模式"**
3. 点击 **"加载解压缩的扩展"**
4. 选择本项目目录

### 2. 安装依赖

**需要 CUDA 显卡 (如 RTX 3060+ / RTX 5070 Ti)**

```bash
pip install faster-whisper fastapi uvicorn nvidia-cublas-cu12
```

### 3. 启动服务

双击 `start_server.bat`，或在终端运行：

```bash
set WHISPER_API_KEY=your_secret_key    （可选）
python whisper_server.py
```

服务将在 `http://127.0.0.1:8760` 启动。

### 4. 配置扩展

1. 右键扩展图标 → **"选项"** 进入设置页
2. 填入 **Whisper 服务地址**（默认 `http://127.0.0.1:8760`）
3. 如果设置了 API 密钥，填入 **API 密钥** 字段
4. 点击 **"检测"** 确认服务在线
5. 点击 **"保存设置"**

### 5. 使用

1. 打开任意包含视频的网页（B站、YouTube 等）
2. 点击页面右下角的「🎬 字幕」提示按钮
3. 字幕将自动显示在视频底部
4. 拖拽控制栏调整位置，再次点击关闭

## 模型选择

启动时通过环境变量切换模型：

```bash
set WHISPER_MODEL=large-v3
python whisper_server.py
```

| 模型 | 大小 | VRAM | 精度 | 推荐 |
|------|------|------|------|------|
| `large-v3-turbo` | 1.6GB | ~6GB | ★★★★ | **默认** |
| `large-v3` | 2.9GB | ~10GB | ★★★★★ | 最高精度 |
| `medium` | 1.5GB | ~5GB | ★★★ | 低显存 |

## 设置项

| 配置 | 默认 | 说明 |
|------|------|------|
| 服务地址 | `http://127.0.0.1:8760` | Whisper 服务地址 |
| API 密钥 | 空 | 留空则不验证 |
| 模型 | `large-v3-turbo` | 需与启动的模型一致 |
| 音频切片 | 3 秒 | 切片间隔，越小延迟越低 |
| 字号 | 中 (28px) | 小/中/大 |
| 最大行数 | 2 | 1~3 行 |
| 底部偏移 | 60px | 距页面底部的距离（拖动后可覆盖） |
| 透明度 | 0.75 | 背景透明度 |
| 识别语言 | 自动检测 | 可选中文/英文/日文 |
| 音频设备 | 自动 | 可选手动选择输入设备 |

## 目录结构

```
├── manifest.json        # Edge 扩展清单 (Manifest V3)
├── background.js        # Service Worker
├── content.js           # 核心逻辑（音频捕获 + Whisper 客户端 + 字幕 UI）
├── subtitle.css         # 字幕样式
├── settings.html        # 设置页面
├── settings.js          # 设置页逻辑
├── whisper_server.py    # 本地 Whisper 服务 (faster-whisper)
├── start_server.bat     # 一键启动脚本
├── icons/               # 扩展图标
└── README.md
```

## 常见问题

**Q: 扩展检测不到视频？**
确保视频是 HTML5 `<video>` 元素。某些网站使用自定义播放器（如 SHPlayer），换个网站测试。

**Q: 没有声音输出了？**
扩展优先使用 `captureStream` 捕获视频音频，不影响原视频声音。如果降级到 `createMediaElementSource` 可能静音。

**Q: 服务启动报 cublas64_12.dll 找不到？**
安装 `pip install nvidia-cublas-cu12`，重启服务。

**Q: 字幕延迟高？**
在设置中将音频切片间隔从 3 秒改为 2 秒可降低延迟，但会增加 GPU 负载。

**Q: CUDA 不可用？**
运行 `python -c "import torch; print(torch.cuda.is_available())"` 检查。RTX 5070 Ti 需 PyTorch 2.8+ cu128 以上。

## 许可证

GPL-3.0
