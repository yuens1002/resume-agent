@echo off
cd /d C:\Users\yuens\dev\resume-agent
echo [%date% %time%] Starting sync >> logs\sync.log 2>&1
C:\nvm4w\nodejs\npm.cmd run sync >> logs\sync.log 2>&1
echo [%date% %time%] Sync complete >> logs\sync.log 2>&1
