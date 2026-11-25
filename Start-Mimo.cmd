@echo off
cd /d "%~dp0"
if exist "node_modules\electron\path.txt" if exist "node_modules\electron\dist\version" if exist "node_modules\kokoro-js\package.json" goto launch
call npm.cmd install
if errorlevel 1 goto failed
node node_modules\electron\install.js
if errorlevel 1 goto failed
if not exist "node_modules\electron\path.txt" goto failed
if not exist "node_modules\electron\dist\version" goto failed
:launch
call npm.cmd start
if not errorlevel 1 exit /b 0
:failed
echo Mimo could not start. Review the message above.
pause
exit /b 1
