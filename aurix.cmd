@echo off
rem AURIX root command. Usage: aurix train
rem Starts automated training (existing Python orchestrator) and returns
rem immediately; the supervisor/workers continue independently.
setlocal
if /i "%~1"=="train" (
  pushd "%~dp0services-python" >nul
  "%~dp0.venv\Scripts\python" -m aurix_ai.cli auto-train
  set RC=%errorlevel%
  popd >nul
  exit /b %RC%
)
echo Usage: aurix train
echo   Starts automated training and returns; workers continue independently.
exit /b 2
