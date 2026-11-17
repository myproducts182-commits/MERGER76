#!/usr/bin/env node
// MERGER76 — الجسر المحلي لـ Google Flow (يعمل على جهاز المستخدم، Windows/macOS/Linux)
// ============================================================================
// الفكرة: لا يوجد API رسمي من Google Flow — التوليد يتم داخل متصفحك على موقع
// flow.google بجلسة Google الخاصة بك وكريدتات اشتراكك، تمامًا كاستخدامك للموقع.
// هذا الجسر: يسحب الأوامر من خادم Vercel (استطلاع طويل عبر HTTPS فقط — لا منافذ
// مفتوحة ولا نفق)، ينفذها عبر Chrome DevTools Protocol (CDP) على متصفح مخصص،
// ويعيد الحالة والنتائج للخادم. الجلسة تبقى في متصفحك — لا كوكيز ولا كلمات مرور
// تُرسل لأي مكان. المصادقة مع الخادم بترويسة X-Bridge-Token فقط.
//
// المتطلبات: Node.js 22+ (يستخدم WebSocket المدمج) — بدون أي حزم npm.
// التشغيل: node flow-bridge.js   (أو start-flow-bridge.bat على Windows)
// وضع الاختبار دون لمس Flow أو الكريدتات: FAKE=1 في bridge.env
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const BRIDGE_VERSION = '1.5.0';
const DIR = __dirname;

// ---------- 1) الإعدادات من bridge.env ----------
function loadEnvFile() {
  const candidates = [path.join(DIR, 'bridge.env'), path.join(DIR, '.env')];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!(m[1] in process.env)) process.env[m[1]] = v;
      }
      return p;
    } catch (e) { /* تجاهل */ }
  }
  return null;
}
loadEnvFile();

const CONFIG = {
  mergerUrl: (process.env.MERGER_URL || 'https://merger76.vercel.app').replace(/\/+$/, ''),
  bridgeToken: process.env.BRIDGE_TOKEN || '',
  fake: process.env.FAKE === '1' || process.env.FAKE === 'true',
  cdpPort: Number(process.env.CDP_PORT || 9223),
  profileDir: process.env.PROFILE_DIR || path.join(DIR, 'flow-profile'),
  resultsDir: process.env.RESULTS_DIR || path.join(DIR, 'results'),
  chromePath: process.env.CHROME_PATH || '',
  flowUrl: process.env.FLOW_URL || 'https://labs.google/fx/tools/flow',
};
if (!CONFIG.bridgeToken) {
  console.error('❌ BRIDGE_TOKEN مفقود — أنشئ ملف bridge.env بجانب flow-bridge.js وضع فيه:');
  console.error('   MERGER_URL=https://merger76.vercel.app');
  console.error('   BRIDGE_TOKEN=<نفس القيمة المضبوطة في Vercel>');
  process.exit(1);
}
fs.mkdirSync(CONFIG.resultsDir, { recursive: true });
if (!CONFIG.fake) fs.mkdirSync(CONFIG.profileDir, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '·', ...a);

// ---------- 2) قناة الاتصال بالخادم (HTTPS فقط — كل الاتصالات صادرة من جهازك) ----------
async function apiGet(pathname) {
  const res = await fetch(CONFIG.mergerUrl + pathname, {
    headers: { 'X-Bridge-Token': CONFIG.bridgeToken, Accept: 'application/json' },
  });
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch (e) {}
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${String(j.error || text).slice(0, 200)}`);
  return j;
}

async function apiPost(pathname, body) {
  const res = await fetch(CONFIG.mergerUrl + pathname, {
    method: 'POST',
    headers: { 'X-Bridge-Token': CONFIG.bridgeToken, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch (e) {}
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${String(j.error || text).slice(0, 200)}`);
  return j;
}

async function sendHeartbeat(extraInfo = {}) {
  const info = {
    machine: `${os.hostname()} (${os.platform()} ${os.release()})`,
    node: process.version,
    fake: CONFIG.fake,
    flowPage: (global.__flowPageUrl || null),
    ...extraInfo,
  };
  try {
    await apiPost('/api/flow/bridge', { type: 'heartbeat', version: BRIDGE_VERSION, info });
    return true;
  } catch (e) {
    log('⚠ فشل النبض:', e.message);
    return false;
  }
}

async function postProgress(jobId, progress, stage, status = 'running') {
  try { await apiPost('/api/flow/bridge', { type: 'progress', job_id: jobId, progress, stage, status }); } catch (e) { log('⚠ فشل إرسال التقدم:', e.message); }
}

async function postResult(commandId, ok, result) {
  try { await apiPost('/api/flow/bridge', { type: 'result', command_id: commandId, ok, result }); } catch (e) { log('⚠ فشل إرسال النتيجة:', e.message); }
}

// رفع ملف النتيجة شرائح base64 (~700KB للشريحة) ليتم بثه عبر /api/flow/file/{jobId}
const CHUNK_RAW = 700 * 1024;
async function postFileChunks(jobId, buf, mime, name, localPath) {
  const chunks = Math.ceil(buf.length / CHUNK_RAW) || 1;
  for (let seq = 0; seq < chunks; seq++) {
    const part = buf.subarray(seq * CHUNK_RAW, Math.min(buf.length, (seq + 1) * CHUNK_RAW));
    await apiPost('/api/flow/bridge', { type: 'file_chunk', job_id: jobId, seq, data: part.toString('base64') });
    log(`📤 شريحة ${seq + 1}/${chunks} رُفعت (${Math.round(part.length / 1024)} KB)`);
  }
  return { file: { name, mime, size: buf.length, chunks, localPath } };
}

// ---------- 3) عميل CDP مبسط فوق WebSocket المدمج (بدون أي حزم) ----------
class CDP {
  constructor(url) { this.url = url; this.ws = null; this.nextId = 1; this.pending = new Map(); this.listeners = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message || 'CDP error'}${msg.error.data ? ': ' + String(msg.error.data).slice(0, 300) : ''}`));
        else resolve(msg.result || {});
        return;
      }
      if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) {
          try { fn(msg.params || {}, msg.sessionId); } catch (e) {}
        }
      }
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const body = { id, method, params };
    if (sessionId) body.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(body)); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }
  // انتظار حدث مع مطابقة (مهلة افتراضية 30 ثانية)
  waitEvent(method, match = () => true, timeoutMs = 30000, sessionId = undefined) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`timeout waiting event ${method}`)); }, timeoutMs);
      const fn = (params, sid) => {
        if (sessionId && sid !== sessionId) return;
        if (!match(params)) return;
        clearTimeout(timer); off(); resolve(params);
      };
      const off = () => this.listeners.set(method, (this.listeners.get(method) || []).filter((f) => f !== fn));
      this.on(method, fn);
    });
  }
  close() { try { this.ws && this.ws.close(); } catch (e) {} }
}

// ---------- 4) تشغيل Chrome بجلسة مخصصة + ربط CDP ----------
function findChromePath() {
  if (CONFIG.chromePath && fs.existsSync(CONFIG.chromePath)) return CONFIG.chromePath;
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(lad, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return null;
}

async function launchChromeAndGetCDP() {
  const exe = findChromePath();
  if (!exe) throw new Error('لم أجد Chrome/Edge على الجهاز — ضع المسار في bridge.env (CHROME_PATH=C:\\path\\to\\chrome.exe)');
  const args = [
    `--user-data-dir=${CONFIG.profileDir}`,
    `--remote-debugging-port=${CONFIG.cdpPort}`,
    '--no-first-run', '--no-default-browser-check', '--disable-features=Translate',
    '--window-size=1440,940',
    CONFIG.flowUrl,
  ];
  log('🚀 تشغيل المتصفح بجلسة مخصصة:', exe);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();

  // انتظار منفذ تصحيح CDP
  const deadline = Date.now() + 45000;
  let versionInfo = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/version`);
      if (res.ok) { versionInfo = await res.json(); break; }
    } catch (e) { /* لم يجهز بعد */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!versionInfo) throw new Error('انتهت مهلة انتظار CDP — أغلق نوافذ Chrome القديمة أو غيّر CDP_PORT في bridge.env');
  const wsUrl = versionInfo.webSocketDebuggerUrl;
  log('🔗 CDP جاهز:', versionInfo.Browser || wsUrl);
  const cdp = new CDP(wsUrl);
  await cdp.connect();
  return { cdp, exe };
}

// فتح/إيجاد تبويب Flow وإرفاق جلسة
async function attachFlowTab(cdp) {
  const list = await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/list`).then((r) => r.json()).catch(() => []);
  let tab = list.find((t) => t.type === 'page' && /flow|labs\.google/i.test(t.url || ''));
  if (!tab) tab = list.find((t) => t.type === 'page');
  let targetId;
  if (tab) {
    targetId = tab.id;
    if (!/flow|labs\.google/i.test(tab.url || '')) {
      await cdp.send('Target.navigateIfNeeded', { targetId, url: CONFIG.flowUrl }).catch(() => {});
    }
  } else {
    const created = await cdp.send('Target.createTarget', { url: CONFIG.flowUrl });
    targetId = created.targetId;
  }
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  // تنزيلات الملفات إلى مجلد results
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: CONFIG.resultsDir, eventsEnabled: true }).catch(() => {});
  return sessionId;
}

// تقييم JS داخل الصفحة مع إرجاع القيمة
async function evalPage(cdp, sessionId, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, userGesture: true,
  }, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('page-eval: ' + ((d.exception && d.exception.description) || d.text || 'خطأ في الصفحة').slice(0, 400));
  }
  return r.result ? r.result.value : undefined;
}

// التقط صورة نصية للصفحة (أزرار/حقول/عناوين) لضبط المحددات معًا عند الحاجة
async function pageSnapshot(cdp, sessionId) {
  try {
    return await evalPage(cdp, sessionId, `(() => {
      const txt = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
      const buttons = [...document.querySelectorAll('button, [role="button"], a')].map(txt).filter(Boolean).slice(0, 40);
      const inputs = [...document.querySelectorAll('textarea, [contenteditable="true"]')].map((el) => ({
        tag: el.tagName, label: txt(el), visible: !!el.offsetParent,
      })).slice(0, 10);
      return JSON.stringify({
        url: location.href, title: document.title,
        hasSignIn: !!document.querySelector('a[href*="accounts.google.com"], button[data-sign-in], [aria-label*="Sign in" i], [aria-label*="تسجيل الدخول" i]'),
        models: [...document.body.innerText.matchAll(/(Veo[\\s\\d.\\-]*\\w*|Omni Flash|Nano Banana\\s*\\w*)/gi)].map((m) => m[1]).slice(0, 10),
        buttons, inputs,
        bodyHint: document.body.innerText.slice(0, 600),
      });
    })()`);
  } catch (e) {
    return JSON.stringify({ error: String(e.message) });
  }
}

// ---------- 5) مشغّل واجهة Google Flow (أتمتة DOM عبر CDP) ----------
// ملاحظة صادقة: Flow يقاوم الأتمتة الخارجية (منذ 9/2026 يتجاهل نقرات غير موثوقة
// بسبب فحص reCAPTCHA). لذا نستخدم 3 استراتيجيات تحفيز بالترتيب: نقرات ماوس حقيقية
// عبر CDP Input (أكثر موثوقية) → click برمجي → Enter. عند الفشل نعيد لقطة الصفحة
// لضبط المحددات معًا. أداة probe تفحص الحساب دون أي استهلاك كريدتات.
const FLOW_JS = {
  // ضبط نص الوصف في صندوق Flow (يدعم textarea و contenteditable مع أحداث React)
  setPrompt: (text) => `(() => {
    const boxes = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter((el) => el.offsetParent);
    if (!boxes.length) return JSON.stringify({ ok: false, reason: 'no-prompt-box' });
    const el = boxes[boxes.length - 1];
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
      setter.call(el, '');
      setter.call(el, ${JSON.stringify('{{TEXT}}')});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, ${JSON.stringify('{{TEXT}}')});
    }
    return JSON.stringify({ ok: true, length: el.value !== undefined ? el.value.length : el.textContent.length });
  })()`,
  // قائمة مرشحات زر الإنشاء بأولوية — نص أو aria-label
  findGenerateBtn: `(() => {
    const cands = [...document.querySelectorAll('button, [role="button"]')].filter((el) => el.offsetParent);
    const score = (el) => {
      const t = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
      if (/^\\s*(create|generate|submit|إنشاء|توليد)\\s*$/.test(t)) return 3;
      if (t.includes('arrow') || /\\b(new|نص جديد)\\b/.test(t)) return 1;
      return 0;
    };
    let best = null, bestScore = 0;
    for (const el of cands) { const s = score(el); if (s > bestScore) { best = el; bestScore = s; } }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (best.getAttribute('aria-label') || best.textContent || '').slice(0, 50) };
  })()`,
  // مراقبة حالة التوليد: بطاقات النتائج مقابل مؤشرات التحميل
  watchState: (baselineTiles) => `(() => {
    const spin = document.querySelectorAll('[data-test-id*="loading" i], .animate-spin, [aria-busy="true"], [class*="spinner" i], [class*="progress" i]').length;
    const tiles = document.querySelectorAll('video, img[alt*="generated" i], [data-test-id*="output" i], [class*="result" i]').length;
    const text = document.body.innerText.slice(0, 400);
    const err = /went wrong|error|failed|فشل|خطأ/.test(document.body.innerText.slice(-2000));
    return JSON.stringify({ spin, tiles, baselineTiles, err, text });
  })()`,
};

async function requireLoginCheck(cdp, sessionId) {
  const snap = JSON.parse(await pageSnapshot(cdp, sessionId));
  if (snap.hasSignIn) {
    throw new Error(`لم تسجل الدخول إلى Google Flow في المتصفح المخصص. افتح نافذة المتصفح التي فتحها الجسر وسجّل الدخول إلى flow.google بحسابك مرة واحدة، ثم أعد المحاولة. لقطة الصفحة: ${JSON.stringify({ url: snap.url, buttons: (snap.buttons || []).slice(0, 8) }).slice(0, 500)}`);
  }
  return snap;
}

// الانتظار حتى تجهز الصفحة بعد التنقل
async function waitPageReady(cdp, sessionId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const st = await evalPage(cdp, sessionId, `JSON.stringify({ready: document.readyState, url: location.href, busy: !!document.querySelector('.animate-spin')})`);
      const s = JSON.parse(st);
      if (s.ready === 'complete') return s;
    } catch (e) { /* الصفحة تتنقل */ }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error('انتهت مهلة تحميل صفحة Flow');
}

// استراتيجيات النقر الثلاث
async function clickGenerate(cdp, sessionId) {
  const btn = JSON.parse(await evalPage(cdp, sessionId, FLOW_JS.findGenerateBtn));
  if (btn && Number.isFinite(btn.x)) {
    // الاستراتيجية 1: نقرات ماوس حقيقية عبر CDP (أكثر قابلية للقبول من فحوص الأمان)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(btn.x), y: Math.round(btn.y) }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(btn.x), y: Math.round(btn.y), button: 'left', clickCount: 1 }, sessionId);
    await new Promise((r) => setTimeout(r, 90));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(btn.x), y: Math.round(btn.y), button: 'left', clickCount: 1 }, sessionId);
    return { strategy: 'cdp-mouse', button: btn.text };
  }
  // الاستراتيجية 2: click برمجي على أفضل مرشح نصي
  const clicked = await evalPage(cdp, sessionId, `(() => {
    const els = [...document.querySelectorAll('button, [role="button"]')].filter((el) => el.offsetParent);
    const el = els.find((b) => /^(create|generate|submit|إنشاء|توليد)$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()))
      || els.find((b) => (b.textContent || '').includes('arrow_forward') || b.querySelector('[aria-label*="arrow" i], [class*="arrow" i]'));
    if (!el) return 'no-button';
    el.click();
    return 'clicked';
  })()`);
  if (clicked === 'clicked') return { strategy: 'js-click' };
  // الاستراتيجية 3: Enter داخل صندوق الوصف
  await evalPage(cdp, sessionId, `(() => {
    const boxes = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter((el) => el.offsetParent);
    const el = boxes[boxes.length - 1];
    if (!el) return 'no-box';
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return 'enter';
  })()`);
  return { strategy: 'enter' };
}

// اختيار موديل/نسبة/عدد اختياري عبر النص — أفضل جهد مع تقرير صريح
async function trySelectOptions(cdp, sessionId, { model, aspect_ratio, count }) {
  const report = { model: null, aspect_ratio: null, count: null };
  const clickByText = (txt) => evalPage(cdp, sessionId, `(() => {
    const t = ${JSON.stringify(String(txt || ''))}.toLowerCase();
    if (!t) return 'skip';
    const els = [...document.querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"], li, span')].filter((el) => el.offsetParent);
    const el = els.find((b) => (b.textContent || '').toLowerCase().includes(t));
    if (!el) return 'not-found';
    el.click();
    return 'clicked:' + (el.textContent || '').trim().slice(0, 40);
  })()`);
  if (model) report.model = await clickByText(model).catch((e) => 'error: ' + e.message);
  if (aspect_ratio) report.aspect_ratio = await clickByText(aspect_ratio).catch((e) => 'error: ' + e.message);
  if (count) report.count = await clickByText(String(count)).catch((e) => 'error: ' + e.message);
  return report;
}

// تنفيذ توليد كامل (فيديو أو صورة) على واجهة Flow
async function runFlowGeneration(cdp, sessionId, { jobId, kind, prompt, model, aspect_ratio, count }) {
  global.__flowPageUrl = null;
  await postProgress(jobId, 5, 'فحص تسجيل الدخول وفتح Flow…');
  await requireLoginCheck(cdp, sessionId);
  await waitPageReady(cdp, sessionId);
  global.__flowPageUrl = await evalPage(cdp, sessionId, 'location.href').catch(() => null);

  // If we are on the tool landing page, try entering a new project
  await evalPage(cdp, sessionId, `(() => {
    const el = [...document.querySelectorAll('button, [role="button"], a')].find((b) => /new project|مشروع جديد|new flow/i.test(b.textContent || ''));
    if (el) el.click();
    return 'ok';
  })()`).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  await waitPageReady(cdp, sessionId);

  await postProgress(jobId, 15, 'ضبط الخيارات…');
  const optionsReport = await trySelectOptions(cdp, sessionId, { model, aspect_ratio, count });

  await postProgress(jobId, 25, 'كتابة الوصف…');
  const setJs = FLOW_JS.setPrompt.replace(/\{\{TEXT\}\}/g, prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
  const setResult = JSON.parse(await evalPage(cdp, sessionId, setJs));
  if (!setResult.ok) {
    const snap = await pageSnapshot(cdp, sessionId);
    throw new Error(`لم أجد صندوق الوصف في واجهة Flow. لقطة الصفحة للمعايرة: ${snap.slice(0, 700)}`);
  }

  await postProgress(jobId, 35, 'بدء التوليد…');
  const baselineTiles = Number(await evalPage(cdp, sessionId, `document.querySelectorAll('video, [class*="result" i]').length`).catch(() => 0)) || 0;
  const trigger = await clickGenerate(cdp, sessionId);

  // مراقبة حتى الاكتمال (مهلة 12 دقيقة للفيديو، 5 للصورة)
  const maxMs = kind === 'video' ? 12 * 60 * 1000 : 5 * 60 * 1000;
  const deadline = Date.now() + maxMs;
  let lastStage = 0;
  let tiles = baselineTiles;
  let spin = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    let st;
    try { st = JSON.parse(await evalPage(cdp, sessionId, FLOW_JS.watchState(baselineTiles))); } catch (e) { continue; }
    tiles = st.tiles; spin = st.spin;
    if (st.err) { const snap = await pageSnapshot(cdp, sessionId); throw new Error(`أظهرت صفحة Flow خطأ أثناء التوليد. لقطة: ${snap.slice(0, 500)}`); }
    const pct = Math.min(95, 40 + Math.round(((Date.now() - (deadline - maxMs)) / maxMs) * 50));
    if (pct > lastStage) { lastStage = pct; await postProgress(jobId, pct, `توليد قيد التنفيذ (${spin} مؤشر تحميل، ${tiles} بطاقة)…`); }
    if (spin === 0 && tiles > baselineTiles) break;
  }
  if (spin > 0) throw new Error('انتهت مهلة الانتظار (12 دقيقة) ولم يكتمل التوليد — راقب نافذة المتصفح، وإن اكتمل لاحقًا أعد الأمر.');
  if (tiles <= baselineTiles) {
    const snap = await pageSnapshot(cdp, sessionId);
    throw new Error(`لم أرصد بطاقات نتيجة جديدة. قد تكون النقرة رُفضت (فحص الأمان في Flow) — استخدم probe للمعايرة. لقطة: ${snap.slice(0, 600)}`);
  }

  await postProgress(jobId, 96, 'تحميل الملف الناتج…');
  const downloaded = await downloadLatestTile(cdp, sessionId, jobId);
  await postProgress(jobId, 99, 'رفع النتيجة إلى الخادم…');
  return { summary: `تم التوليد (${kind}) عبر استراتيجية ${trigger.strategy}${model ? ` · موديل: ${optionsReport.model}` : ''}`, ...downloaded };
}

// نقر زر تنزيل أحدث بطاقة وانتظار ظهور الملف في results
async function downloadLatestTile(cdp, sessionId, jobId) {
  const before = fs.readdirSync(CONFIG.resultsDir).filter((f) => /\.(mp4|png|jpg|jpeg|webp)$/i.test(f));
  await evalPage(cdp, sessionId, `(() => {
    const btns = [...document.querySelectorAll('button, a, [role="button"]')].filter((el) => el.offsetParent && /download|تنزيل/i.test((el.getAttribute('aria-label') || el.textContent || '')));
    if (!btns.length) return 'no-download-button';
    btns[btns.length - 1].click();
    return 'clicked';
  })()`);
  // انتظار ملف جديد حتى 60 ثانية
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const after = fs.readdirSync(CONFIG.resultsDir).filter((f) => /\.(mp4|png|jpg|jpeg|webp)$/i.test(f));
    const fresh = after.find((f) => !before.includes(f));
    if (fresh) {
      const p = path.join(CONFIG.resultsDir, fresh);
      // انتظار اكتمال كتابة الملف
      let size1 = -1, size2 = -2;
      for (let i = 0; i < 10; i++) { try { size1 = fs.statSync(p).size; await new Promise((r) => setTimeout(r, 1200)); size2 = fs.statSync(p).size; if (size1 === size2 && size1 > 1024) break; } catch (e) {} }
      const mime = /\.(mp4)$/i.test(fresh) ? 'video/mp4' : /\.(png)$/i.test(fresh) ? 'image/png' : 'image/jpeg';
      return await postFileChunks(jobId, fs.readFileSync(p), mime, fresh, p);
    }
  }
  // لم يوجد زر تنزيل أو الملف لم يظهر — نعيد معلومات بدل الفشل الصامت
  const snap = await pageSnapshot(cdp, sessionId);
  return { file: null, note: `لم أعثر على زر تنزيل أو لم يظهر الملف في ${CONFIG.resultsDir} — النتيجة مرئية في المتصفح. لقطة للمعايرة: ${snap.slice(0, 400)}` };
}

// فحص الحساب — بدون أي توليد ولا استهلاك كريدتات
async function runProbe(cdp, sessionId) {
  global.__flowPageUrl = null;
  await waitPageReady(cdp, sessionId);
  global.__flowPageUrl = await evalPage(cdp, sessionId, 'location.href').catch(() => null);
  const snap = JSON.parse(await pageSnapshot(cdp, sessionId));
  return {
    summary: `فحص حساب Flow: ${snap.hasSignIn ? 'غير مسجل الدخول — سجل دخولك في نافذة المتصفح المفتوحة' : 'مسجل الدخول ✅'}`,
    account: { loggedIn: !snap.hasSignIn, modelsDetected: snap.models || [], url: snap.url, title: snap.title },
    ui: { buttons: (snap.buttons || []).slice(0, 20), promptBoxes: snap.inputs || [] },
    note: 'هذا فحص قراءة فقط — لا كريدتات استُهلكت. شاركني محتوى ui.buttons إن احتاج المشغل ضبطًا.',
  };
}

// رفع صورة مرجعية من رابط عام إلى المشروع الحالي
async function runUploadReference(cdp, sessionId, { jobId, image_url }) {
  await postProgress(jobId, 10, 'تنزيل الصورة محليًا…');
  const res = await fetch(image_url);
  if (!res.ok) throw new Error(`تعذر تنزيل الصورة (HTTP ${res.status})`);
  const mime = (res.headers.get('content-type') || 'image/png').split(';')[0];
  const ext = mime.includes('jpeg') ? '.jpg' : mime.includes('webp') ? '.webp' : '.png';
  const localPath = path.join(CONFIG.resultsDir, `ref-${jobId.slice(0, 8)}${ext}`);
  fs.writeFileSync(localPath, Buffer.from(await res.arrayBuffer()));
  await postProgress(jobId, 40, 'البحث عن حقل رفع في Flow…');
  await requireLoginCheck(cdp, sessionId);
  const nodeInfo = await cdp.send('DOM.getDocument', { depth: -1 }, sessionId);
  const inputNode = await cdp.send('DOM.querySelector', { nodeId: nodeInfo.root.nodeId, selector: 'input[type="file"]' }, sessionId).catch(() => null);
  if (!inputNode || !inputNode.nodeId) {
    const snap = await pageSnapshot(cdp, sessionId);
    throw new Error(`لا يوجد input[type=file] ظاهر في الصفحة الحالية — افتح Flow واضغط زر "+"/إضافة مرجع يدويًا مرة ليظهر الحقل، أو أبلغني بلقطة الصفحة. لقطة: ${snap.slice(0, 400)}`);
  }
  await cdp.send('DOM.setFileInputFiles', { files: [localPath], nodeId: inputNode.nodeId }, sessionId);
  await postProgress(jobId, 85, 'انتظار معالجة الصورة…');
  await new Promise((r) => setTimeout(r, 4000));
  return { summary: 'رُفعت الصورة المرجعية إلى Flow', file: null, localPath };
}

// ---------- 6) وضع المحاكاة FAKE — اختبار القناة كاملة دون Chrome ودون كريدتات ----------
// ينفذ نفس دورة الحياة (قائمة الأوامر → تقدم → نتيجة → رفع ملف شرائح) بقيم وهمية،
// ليتأكد المستخدم أن الجسر ↔ الخادم ↔ MCP تعمل قبل أول توليد حقيقي.
async function fakeHandle(cmd) {
  const { id, type, payload = {} } = cmd;
  const jobId = payload.jobId;
  if (type === 'probe') {
    await sendHeartbeat();
    return {
      summary: 'وضع المحاكاة — القناة تعمل ✅ (لم يُلمس Flow ولا استُهلك كريدت واحد)',
      account: { loggedIn: true, modelsDetected: ['FAKE — Omni Flash', 'FAKE — Veo 3.1 - Fast', 'FAKE — Nano Banana Pro'], url: 'fake://bridge', title: 'FAKE MODE' },
      ui: { note: 'شغّل FAKE=0 في bridge.env بعد نجاح هذا الفحص لتشغيل المتصفح الحقيقي.' },
    };
  }
  if (type === 'generate_video' || type === 'generate_image') {
    for (const [pct, stage] of [[10, 'محاكاة: بدء التوليد…'], [35, 'محاكاة: 35%…'], [60, 'محاكاة: 60%…'], [85, 'محاكاة: 90%…'], [99, 'محاكاة: تجهيز الملف…']]) {
      await new Promise((r) => setTimeout(r, 2000));
      await postProgress(jobId, pct, stage);
    }
    // ملف وهمي حقيقي البنية (يتجاوز 700KB لاختبار الشرائح)
    const fake = Buffer.alloc(1600 * 1024, 0);
    fake.write('FAKE-MP4-HEADER-MERGER76', 0);
    const name = `fake-${type}-${jobId.slice(0, 8)}.${type === 'generate_video' ? 'mp4' : 'png'}`;
    const p = path.join(CONFIG.resultsDir, name);
    fs.writeFileSync(p, fake);
    await postProgress(jobId, 99, 'محاكاة: رفع الملف…');
    return {
      summary: `محاكاة مكتملة (${type}) — ملف وهمي 1.6MB اختبر رفع الشرائح والبث`,
      ...await postFileChunks(jobId, fake, type === 'generate_video' ? 'video/mp4' : 'image/png', name, p),
    };
  }
  if (type === 'upload_reference') {
    await new Promise((r) => setTimeout(r, 1500));
    return { summary: 'محاكاة: رفع المرجع (FAKE)', file: null };
  }
  return { summary: `محاكاة: أمر ${type} أُخذ`, file: null };
}

// ---------- 7) توزيع الأوامر ----------
let cdpRef = null; // { cdp, sessionId }
let chromeStarted = false;

async function ensureChrome() {
  if (CONFIG.fake) return null;
  if (cdpRef) {
    // تحقق من حيوية الاتصال
    try { await cdpRef.cdp.send('Runtime.evaluate', { expression: '1', returnByValue: true }, cdpRef.sessionId); return cdpRef; } catch (e) { cdpRef = null; }
  }
  log('🌐 تشغيل/إعادة ربط المتصفح…');
  const { cdp } = await launchChromeAndGetCDP();
  const sessionId = await attachFlowTab(cdp);
  cdpRef = { cdp, sessionId };
  chromeStarted = true;
  return cdpRef;
}

async function handleCommand(cmd) {
  const { id, type, payload = {} } = cmd;
  log('📥 أمر جديد:', type, payload.jobId ? `(مهمة ${payload.jobId.slice(0, 8)}…)` : '');
  try {
    if (CONFIG.fake) {
      const result = await fakeHandle(cmd);
      await postResult(id, true, result);
      log('✅ اكتمل (محاكاة):', type);
      return;
    }
    const { cdp, sessionId } = await ensureChrome();
    let result;
    if (type === 'probe') result = await runProbe(cdp, sessionId);
    else if (type === 'generate_video' || type === 'generate_image') {
      result = await runFlowGeneration(cdp, sessionId, {
        jobId: payload.jobId, kind: type === 'generate_video' ? 'video' : 'image',
        prompt: payload.prompt, model: payload.model, aspect_ratio: payload.aspect_ratio, count: payload.count,
      });
    } else if (type === 'upload_reference') result = await runUploadReference(cdp, sessionId, payload);
    else if (type === 'serve_file') {
      const jid = payload.jobId;
      const p = path.join(CONFIG.resultsDir, payload.fileName || '');
      if (!fs.existsSync(p)) throw new Error(`الملف ${p} غير موجود في مجلد results`);
      result = await postFileChunks(jid, fs.readFileSync(p), payload.mime || 'video/mp4', path.basename(p), p);
    } else result = { summary: `أمر غير معروف: ${type}` };
    await postResult(id, true, result);
    log('✅ اكتمل:', type);
  } catch (e) {
    log('❌ فشل الأمر', type, ':', String(e.message).slice(0, 300));
    await postResult(id, false, { error: String(e.message).slice(0, 1000) });
  }
}

// ---------- 8) الحلقة الرئيسية ----------
async function main() {
  log('🌉 MERGER76 Flow Bridge v' + BRIDGE_VERSION + (CONFIG.fake ? ' — وضع المحاكاة FAKE' : ''));
  log('   الخادم:', CONFIG.mergerUrl);
  log('   مجلد النتائج:', CONFIG.resultsDir);
  await sendHeartbeat();
  log('💓 نبض أولي أُرسل — إن ظهرت رسالة 503 فBRIDGE_TOKEN غير مضبوط على Vercel بعد.');

  let consecutiveFailures = 0;
  for (;;) {
    try {
      // استطلاع طويل — الاتصال نفسه نبض؛ الأوامر تصل خلال ثوانٍ
      const r = await apiGet('/api/flow/bridge?wait=1');
      consecutiveFailures = 0;
      if (r.command) await handleCommand(r.command);
      else await sendHeartbeat();
    } catch (e) {
      consecutiveFailures++;
      if (consecutiveFailures <= 2 || consecutiveFailures % 10 === 0) log('⚠ خطأ استطلاع:', e.message);
      await new Promise((r2) => setTimeout(r2, Math.min(15000, 2000 * consecutiveFailures)));
      if (consecutiveFailures % 3 === 0) await sendHeartbeat();
    }
  }
}

process.on('SIGINT', () => { log('👋 إيقاف…'); try { cdpRef && cdpRef.cdp.close(); } catch (e) {} process.exit(0); });
main().catch((e) => { console.error('❌ انهار الجسر:', e); process.exit(1); });


