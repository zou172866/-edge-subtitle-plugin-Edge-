# 🎬 实时中文字幕 - Edge 扩展

为 **网页 HTML5 视频** 添加实时中文字幕。基于本地 Whisper 服务捕获视频音频流进行语音识别。

基于 [VideoCaptioner](https://github.com/WEIFENG2333/VideoCaptioner) 项目思路开发。


## ⚡ 快速开始

1. 安装依赖：`pip install faster-whisper fastapi uvicorn nvidia-cublas-cu12`
2. 双击 `start_server.bat` 启动 Whisper 服务
3. Edge 打开 `edge://extensions`，开启"开发人员模式"，加载本项目目录
4. 打开任意视频网页，点右下角「🎬 字幕」




## 功能

- 🎬 **视频音频捕获**：自动检测页面中的 `<video>` 元素，捕获其音频输出
- 🧠 **Whisper 本地识别**：利用 GPU 进行高速语音识别（需 RTX 显卡）
- 🎨 **字幕样式**：传统视频字幕风格，半透明背景、大字、底部居中
- 🖱️ **可拖动**：字幕位置可上下拖动调整
- 🔒 **安全**：Whisper 服务仅监听 127.0.0.1，可选 API 密钥验证

## 工作原理

```
网页 <video> → AudioContext/CaptureStream 捕获音频
       ↓
  MediaRecorder 每 2.5~3 秒切片
       ↓
  发送到本地 Whisper 服务 (127.0.0.1:8760)
       ↓
  faster-whisper GPU 识别
       ↓
  返回文字 → 显示在底部字幕条
```

## 安装

### 1. 加载扩展

1. 打开 Edge 浏览器，进入 `edge://extensions`
2. 开启 **"开发人员模式"**
3. 点击 **"加载解压缩的扩展"**
4. 选择本项目中的 `edge-subtitle-plugin` 目录

### 2. 安装 Whisper 服务依赖

**需要 CUDA 显卡 (如 RTX 5070 Ti)**

```bash
# 安装 CUDA 版 PyTorch
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124

# 安装其他依赖
pip install faster-whisper fastapi uvicorn soundfile numpy
```

### 3. 启动 Whisper 服务

```bash
# 设置 API 密钥（可选）
set WHISPER_API_KEY=your_secret_key

# 启动服务（默认模型: large-v3-turbo）
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
2. 点击扩展图标 或页面右下角的「🎬 字幕」提示按钮
3. 字幕将自动显示在视频底部
4. 再次点击图标或字幕控制条关闭

## 模型选择

在设置页中可切换 Whisper 模型（需重启服务并点击 `/reload`）：

| 模型 | 参数 | VRAM | 精度 | 推荐场景 |
|------|------|------|------|---------|
| `large-v3-turbo` | 809M | ~6GB | ★★★★ | **默认推荐** |
| `large-v3` | 1.55B | ~10GB | ★★★★★ | 最高精度 |
| `medium` | 769M | ~5GB | ★★★ | 低显存备用 |

启动时通过环境变量切换模型：
```bash
set WHISPER_MODEL=large-v3
python whisper_server.py
```

## 设置项

| 配置 | 默认 | 说明 |
|------|------|------|
| 服务地址 | `http://127.0.0.1:8760` | Whisper 服务地址 |
| API 密钥 | 空 | 留空则不验证 |
| 模型 | `large-v3-turbo` | 需与启动的模型一致 |
| 音频切片 | 3 秒 | 切片间隔，越小延迟越低 |
| 字号 | 中 (28px) | 小/中/大 |
| 最大行数 | 2 | 1~3 行 |
| 底部偏移 | 60px | 距页面底部的距离 |
| 透明度 | 0.75 | 背景透明度 |

## 目录结构

```
edge-subtitle-plugin/
├── manifest.json        # Edge 扩展清单
├── background.js        # Service Worker
├── content.js           # 核心逻辑（视频捕获 + Whisper 客户端 + 字幕 UI）
├── subtitle.css         # 字幕样式
├── settings.html        # 设置页面
├── settings.js          # 设置页逻辑
├── whisper_server.py    # 本地 Whisper 服务
├── icons/               # 扩展图标
└── README.md
```

## 常见问题

**Q: 扩展检测不到视频？**
确保视频是 HTML5 `<video>` 元素。某些网站使用自定义播放器，换个网站测试。

**Q: 没有声音输出了？**
`createMediaElementSource` 可能会影响音频输出。如果遇到此问题，扩展会自动降级为 `captureStream` 模式。

**Q: Whisper 服务启动失败？**
确认已安装 CUDA 版 PyTorch 和 faster-whisper。运行 `python -c "import torch; print(torch.cuda.is_available())"` 检查 CUDA 是否可用。

**Q: 字幕延迟高？**
在设置中将音频切片间隔从 3 秒改为 2 秒可降低延迟，但会增加 GPU 负载。

## 许可证

GPL-3.0
