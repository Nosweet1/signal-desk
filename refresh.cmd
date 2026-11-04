@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE%" set "NODE=node"

rem Watt Toolkit 加速时使用自签证书，本机抓取需跳过证书校验
set NODE_TLS_REJECT_UNAUTHORIZED=0

echo 正在抓取公开信源...
"%NODE%" scripts\fetch.mjs
echo.
echo 数据已写入 data\feed.js
timeout /t 4 >nul
exit /b 0
