@echo off
setlocal
pushd "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Opening the HTML preview instead.
  start "" "%~dp0index.html"
  popd
  exit /b
)
start "" "http://127.0.0.1:8847"
node serve.cjs
popd
pause
