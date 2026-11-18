@echo off
chcp 65001 >nul
title MERGER76 Flow Bridge
cd /d "%~dp0"
echo تشغيل الجسر المحلي لـ Google Flow — اترك هذه النافذة مفتوحة أثناء الاستخدام.
echo للإيقاف: أغلق النافذة أو اضغط Ctrl+C
echo.
node flow-bridge.js
pause
