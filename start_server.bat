@echo off
cd /d "%~dp0"

:: whisper_server.py auto-detects NVIDIA CUDA DLL paths.
:: Supports WHISPER_MODEL / WHISPER_MODEL_DIR env vars.
:: Uncomment below to set manually:
:: set WHISPER_MODEL=large-v3-turbo
:: set WHISPER_MODEL_DIR=C:\path\to\model

python whisper_server.py
pause
