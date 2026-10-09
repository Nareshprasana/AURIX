@echo off
rem AURIX root command — no venv activation, no cd, no extra windows.
rem   aurix                 - interactive terminal control center
rem   aurix train           - start automated training (returns at once; hidden background workers)
rem   aurix train status    - concise training status (IDLE when nothing runs)
rem   aurix train stop      - graceful stop (checkpoints preserved, nothing deleted)
rem   aurix train logs      - recent training events (use: aurix train logs --last 50)
setlocal
if "%~1"=="" (
  pushd "%~dp0services-python" >nul
  "%~dp0.venv\Scripts\python" -m aurix_ai.cli interactive
  set RC=%errorlevel%
  popd >nul
  exit /b %RC%
)
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
  if /i "%~2"=="logs" (
    pushd "%~dp0services-python" >nul
    if "%~3"=="" (
      "%~dp0.venv\Scripts\python" -m aurix_ai.cli auto-logs
    ) else (
      "%~dp0.venv\Scripts\python" -m aurix_ai.cli auto-logs %3 %4
    )
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
echo   aurix                    interactive control center
echo   aurix train              start automated training (background, no extra windows)
echo   aurix train status       show training status
echo   aurix train stop         gracefully stop training (checkpoints preserved)
echo   aurix train logs         show recent training events
exit /b 2
