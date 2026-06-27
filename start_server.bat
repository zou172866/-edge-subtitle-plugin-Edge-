@echo off
cd /d "%~dp0"

set "NVIDIA_BIN=%USERPROFILE%\AppData\Local\Programs\Python\Python311\Lib\site-packages\nvidia\cublas\bin"
set "NVRTC_BIN=%USERPROFILE%\AppData\Local\Programs\Python\Python311\Lib\site-packages\nvidia\cuda_nvrtc\bin"
set "PATH=%NVIDIA_BIN%;%NVRTC_BIN%;%PATH%"

set "WHISPER_MODEL_DIR=%USERPROFILE%\.cache\huggingface\hub\models--mobiuslabsgmbh--faster-whisper-large-v3-turbo\snapshots\0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"

python whisper_server.py
pause
