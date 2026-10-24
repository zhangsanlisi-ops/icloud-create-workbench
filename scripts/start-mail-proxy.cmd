@echo off
cd /d "%~dp0.."
set "PUBLIC_MAIL_PROXY_PORT=4174"
set "BACKEND_ORIGIN=http://127.0.0.1:4173"
node.exe scripts\public-mail-proxy.mjs >> "%CD%\logs\public-mail-proxy.log" 2>> "%CD%\logs\public-mail-proxy-error.log"
