"""
实时字幕 Edge 扩展 - 本地语音识别服务 (faster-whisper)
========================================================
基于 faster-whisper (CTranslate2) 的实时语音识别
监听 127.0.0.1:8760，仅允许本机访问

用法:
  pip install faster-whisper fastapi uvicorn python-multipart
  set WHISPER_API_KEY=your_secret_key        (可选)
  set WHISPER_MODEL=large-v3-turbo           (可选，默认)
  python whisper_server.py
"""

import os
import sys
import time
import glob
import logging
import tempfile
from typing import Optional
from contextlib import asynccontextmanager

# 自动添加 nvidia CUDA DLL 路径（解决 cublas64_12.dll 找不到的问题）
_python_root = os.path.dirname(os.path.dirname(sys.executable))
_nvidia_pattern = os.path.join(_python_root, "Lib", "site-packages", "nvidia", "*", "bin")
for _d in sorted(glob.glob(_nvidia_pattern)):
    if os.path.isdir(_d) and _d not in os.environ.get("PATH", ""):
        os.add_dll_directory(_d) if hasattr(os, "add_dll_directory") else os.environ.__setitem__(
            "PATH", _d + os.pathsep + os.environ.get("PATH", "")
        )

from fastapi import FastAPI, UploadFile, File, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

try:
    from faster_whisper import WhisperModel
except ImportError:
    print("请安装: pip install faster-whisper fastapi uvicorn python-multipart")
    sys.exit(1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("whisper-server")

HOST = "127.0.0.1"
PORT = 8760
API_KEY = os.environ.get("WHISPER_API_KEY", "")


def _has_cuda():
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


# 模型配置
DEFAULT_MODEL_SIZE = os.environ.get("WHISPER_MODEL") or "large-v3-turbo"
# 设备：cuda 或 cpu；留空自动检测
DEVICE = os.environ.get("WHISPER_DEVICE") or ("cuda" if _has_cuda() else "cpu")
# 计算类型：GPU 用 float16，CPU 用 int8
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE") or ("float16" if DEVICE == "cuda" else "int8")
# 模型本地路径（可选，跳过下载）
MODEL_DIR = os.environ.get("WHISPER_MODEL_DIR") or ""

stats = {"total_requests": 0, "total_audio_sec": 0.0, "total_process_sec": 0.0}
model = None
model_size = DEFAULT_MODEL_SIZE
model_loaded = False


def verify_api_key(request: Request):
    if not API_KEY:
        return
    if request.headers.get("X-API-Key", "") != API_KEY:
        raise HTTPException(status_code=403, detail="无效的 API 密钥")


def load_model(size: str):
    global model, model_size, model_loaded

    if MODEL_DIR and os.path.isdir(MODEL_DIR):
        logger.info(f"使用本地模型: {MODEL_DIR}")
        load_start = time.time()
        model = WhisperModel(
            MODEL_DIR,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
            local_files_only=True,
        )
        model_size, model_loaded = size, True
        logger.info(f"模型加载完成 (本地): {size}，设备: {DEVICE}，耗时 {time.time() - load_start:.1f}s")
        return

    logger.info(f"正在加载模型: {size}（首次会自动下载 ~1.6GB）...")
    start = time.time()
    model = WhisperModel(size, device=DEVICE, compute_type=COMPUTE_TYPE)
    model_size, model_loaded = size, True
    logger.info(f"模型加载完成: {size}，设备: {DEVICE}，耗时 {time.time() - start:.1f}s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model(DEFAULT_MODEL_SIZE)
    yield


app = FastAPI(title="实时字幕 Whisper 服务", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
async def health(request: Request):
    verify_api_key(request)
    return {"status": "ok", "model": model_size, "device": DEVICE, "loaded": model_loaded}


@app.post("/asr")
async def transcribe(request: Request, audio: UploadFile = File(...)):
    verify_api_key(request)
    if not model_loaded:
        raise HTTPException(status_code=503, detail="模型未加载")

    content = await audio.read()
    if len(content) < 44:
        raise HTTPException(status_code=400, detail="音频数据太短")

    suffix = ".wav" if content[0:4] == b"RIFF" else ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        process_start = time.time()
        segments_gen, info = model.transcribe(tmp_path, beam_size=5, language=None)
        segments = list(segments_gen)
        elapsed = time.time() - process_start

        detected_lang = info.language
        duration = info.duration

        result_segments = []
        for seg in segments:
            result_segments.append({
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": seg.text.strip(),
            })

        full_text = "".join(s.text for s in segments).strip()

        stats["total_requests"] += 1
        stats["total_audio_sec"] += duration
        stats["total_process_sec"] += elapsed

        logger.info(
            f"✅ 识别完成 | {detected_lang} | {duration:.1f}s | "
            f"{elapsed:.2f}s | {len(result_segments)}段 | {full_text[:50]}"
        )

        return {
            "text": full_text,
            "language": detected_lang,
            "segments": result_segments,
            "duration": round(duration, 2),
            "processing_time": round(elapsed, 3),
        }

    except Exception as e:
        logger.error(f"识别失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


@app.post("/reload")
async def reload_model(request: Request):
    verify_api_key(request)
    import asyncio
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, load_model, DEFAULT_MODEL_SIZE)
    return {"status": "ok", "model": model_size, "device": DEVICE}


@app.get("/stats")
async def get_stats(request: Request):
    verify_api_key(request)
    return {**stats, "model": model_size, "device": DEVICE}


if __name__ == "__main__":
    print("=" * 55)
    print("  实时字幕 — Whisper 服务 (faster-whisper)")
    print("=" * 55)
    print(f"  地址:     http://{HOST}:{PORT}")
    print(f"  模型:     {DEFAULT_MODEL_SIZE}")
    print(f"  设备:     {DEVICE}")
    print(f"  计算精度: {COMPUTE_TYPE}")
    print(f"  API 密钥: {'已设置' if API_KEY else '未设置（无需验证）'}")
    print("=" * 55)
    print("  POST /asr    语音识别")
    print("  GET  /health 健康检查")
    print("  GET  /stats  识别统计")
    print("  POST /reload 重载模型")
    print("=" * 55)
    print("  按 Ctrl+C 停止服务")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
