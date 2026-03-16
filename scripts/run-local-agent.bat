@echo off
setlocal
cd /d %~dp0\..
node .\scripts\run-local-agent.mjs %*
