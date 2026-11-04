@echo off
chcp 65001 >nul
title 信号台 Signal Desk

rem ==== 可自行调整 ====
rem POS = 窗口左上角坐标，按你的屏幕分辨率改
set "POS=1200,40"
set "SIZE=440,820"
set "URL=https://Nosweet1.github.io/signal-desk/"
rem ====================

set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo 未找到 Chrome，请编辑本文件里的 CHROME 路径
  pause
  exit /b 1
)

rem 独立配置目录，保证 --app 无边框窗口生效，且不干扰你日常的 Chrome
start "" "%CHROME%" ^
  --app="%URL%" ^
  --window-size=%SIZE% ^
  --window-position=%POS% ^
  --user-data-dir="%LOCALAPPDATA%\SignalDesk" ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-features=Translate,MediaRouter ^
  --disable-background-networking

exit /b 0
