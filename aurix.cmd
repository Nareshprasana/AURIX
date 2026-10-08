@echo off
rem AURIX root command.
rem   aurix train         - start automated training (returns at once; hidden background workers)
rem   aurix train status  - concise training status (IDLE when nothing runs)
rem   aurix train stop    - graceful stop (checkpoints preserved, nothing deleted)
setlocal
if /i "%~1"=="train" (
  if /i "%~2"=="status" (
    pushd "%~dp0services-python" >nul
    "%~dp0.venv\Scripts\python" -m aurix_ai.cli auto-status --concise
    set RC=%errorlevel%
    popd >nul
    exit /b %RC%
  )
  if /i "%~2"=="stop" (
    pushd "%~dp0services-python" >nul
    "%~dp0.venv\Scripts\python" -m aurix_ai.cli auto-stop
    set RC=%errorlevel%
    popd >nul
    exit /b %RC%
  )
  if "%~2"=="" (
    pushd "%~dp0services-python" >nul
    "%~dp0.venv\Scripts\python" -m aurix_ai.cli auto-train
    set RC=%errorlevel%
    popd >nul
    exit /b %RC%
  )
)
echo Usage:
echo   aurix train          start automated training (background, no extra windows)
echo   aurix train status   show training status
echo   aurix train stop     gracefully stop training (checkpoints preserved)
exit /b 2
