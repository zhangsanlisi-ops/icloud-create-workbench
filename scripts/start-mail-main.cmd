@echo off
cd /d "%~dp0.."
set "PYTHON_COMMAND=%CD%\.venv\Scripts\python.exe"
set "DATABASE_PATH=%CD%\data\workbench.db"
set "HOST=127.0.0.1"
set "PORT=4173"
node.exe src/server.mjs >> "%CD%\logs\server.log" 2>> "%CD%\logs\server-error.log"
