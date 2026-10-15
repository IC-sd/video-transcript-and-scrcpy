@echo off
setlocal
if not exist "%~dp0runtime\python\python.exe" goto missing
if not exist "%~dp0app\mirror.py" goto missing
"%~dp0runtime\python\python.exe" -X utf8 -B "%~dp0app\mirror.py" --project-dir "%~dp0." --diagnose %*
set "MIRROR_RC=%ERRORLEVEL%"
pause
exit /b %MIRROR_RC%
:missing
echo [ERROR] Project files are missing. Run setup.ps1 first.
pause
exit /b 1
