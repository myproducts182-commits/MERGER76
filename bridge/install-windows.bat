@echo off
chcp 65001 >nul
REM ============================================================
REM MERGER76 — مُثبّت الجسر المحلي لـ Google Flow (Windows)
REM يفحص Node، يكتب bridge.env، يسجل التشغيل التلقائي عند الدخول، ويشغّل الجسر.
REM ============================================================
title MERGER76 Flow Bridge — Installer
cd /d "%~dp0"

echo ================================================
echo   MERGER76 — مُثبّت الجسر المحلي لـ Google Flow
echo ================================================
echo.

REM --- فحص Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo [خطأ] Node.js غير مثبت على الجهاز.
  echo       ثبّت النسخة LTS من https://nodejs.org ثم أعد تشغيل هذا الملف.
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%v in ('node -v') do set NODEV=%%v
for /f "tokens=2 delims=v." %%m in ('node -v') do set NODEMINOR=%%m
echo [معلومات] إصدار Node: 
node -v
REM node -v مثل v22.11.0 — نتحقق يدويًا
set MINOR_OK=0
for /f "delims=v. tokens=1,2,3" %%a in ('node -v') do (
  if %%b GEQ 22 set MINOR_OK=1
  if %%a GEQ 24 set MINOR_OK=1
)
if %MINOR_OK%==0 (
  echo [خطأ] يحتاج الجسر Node.js إصدار 22 أو أحدث (WebSocket مدمج).
  echo       حدّث من https://nodejs.org ثم أعد التشغيل.
  pause
  exit /b 1
)

REM --- كتابة bridge.env ---
if exist bridge.env (
  echo [معلومات] bridge.env موجود — لن أستبدله. احذفه يدويًا لإعادة الإعداد.
) else (
  echo.
  echo الصق توكن الجسر (BRIDGE_TOKEN) نفسه المضبوط في Vercel ثم اضغط Enter:
  set /p TOKEN=
  if "%TOKEN%"=="" (
    echo [خطأ] التوكن مطلوب.
    pause
    exit /b 1
  )
  (
    echo MERGER_URL=https://merger76.vercel.app
    echo BRIDGE_TOKEN=%TOKEN%
    echo FAKE=1
    echo CDP_PORT=9223
  ) > bridge.env
  echo [تم] أُنشئ bridge.env — FAKE=1 حاليًا (وضع اختبار آمن بلا كريدتات).
  echo      بعد نجاح الاختبار غيّرها إلى FAKE=0 لتشغيل المتصفح الحقيقي.
)

REM --- تشغيل تلقائي عند تسجيل الدخول (مهمة مجدولة) ---
echo.
echo هل تريد تشغيل الجسر تلقائيًا عند كل تسجيل دخول؟ [Y/n]
set /p AUTOSTART=
if /i not "%AUTOSTART%"=="n" (
  schtasks /query /tn "MERGER76FlowBridge" >nul 2>nul
  if errorlevel 1 (
    schtasks /create /tn "MERGER76FlowBridge" /tr "\"%~dp0start-flow-bridge.bat\"" /sc onlogon /rl limited /f >nul
    if errorlevel 1 (
      echo [تحذير] تعذر إنشاء المهمة المجدولة — يمكنك تشغيل start-flow-bridge.bat يدويًا.
    ) else (
      echo [تم] سيبدأ الجسر تلقائيًا عند كل تسجيل دخول (مهمة: MERGER76FlowBridge).
    )
  ) else (
    echo [معلومات] المهمة المجدولة موجودة مسبقًا.
  )
)

echo.
echo هل تشغّل الجسر الآن؟ [Y/n]
set /p STARTRUN=
if /i not "%STARTRUN%"=="n" (
  call "%~dp0start-flow-bridge.bat"
)
pause
