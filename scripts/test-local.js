// اختبار محلي شامل للنسخة 1.6.0 — يعمل دون مفاتيح حقيقية:
// 1) قائمة الأدوات التسع  2) list_models/check_balance بلا مفاتيح  3) بناء طلبات التحرير/الصوت/الفيديو/الصور
//    فعليًا عبر مفتاح وهمي (يُرفض من المزود 401 — لا تكلفة) والتحقق من params_json في القاعدة
// 4) مسارات التحقق من المعطيات  5) تنظيف كامل (حذف المفتاح الوهمي والمهام التجريبية)
// التشغيل: node scripts/test-local.js
const { spawn } = require('child_process');
const path = require('path');

// وضع الاختبار: getKeyPool لا يُمرّر إلا مفاتيح الاختبار الوهمية —
// حتى لو كانت المفاتيح الحقيقية موجودة في نفس قاعدة Turso (حماية من استهلاك الرصيد)
process.env.MERGER_TEST_MODE = '1';

const ROOT = path.join(__dirname, '..');
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_KEY = 'sk-dp-FAKE-TEST-KEY-000000000000';

let passed = 0, failed = 0;
const failures = [];
const testTaskIds = [];
let fakeKeyId = null;

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function http(pathname, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j = {};
  try { j = await res.json(); } catch (e) {}
  return { status: res.status, data: j };
}

async function mcp(method, params) {
  const r = await http('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params } });
  return r.data;
}

async function callTool(name, args) {
  const r = await mcp('tools/call', { name, arguments: args });
  const c = r.result && r.result.content && r.result.content[0];
  return { text: (c && c.text) || '', isError: !!(r.result && r.result.isError), raw: r };
}

async function waitForServer(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  console.log('🚀 اختبار v1.6.0 — الأنواع الأربعة + النماذج + الرصيد\n');

  // تشغيل خادم التطوير
  const server = spawn('node', [path.join(ROOT, 'scripts/dev-server.js')], {
    env: { ...process.env, PORT: String(PORT), MERGER_TEST_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    const up = await waitForServer();
    ok('خادم التطوير جاهز على ' + BASE, up);
    if (!up) throw new Error('الخادم لم يبدأ');

    const db = require(path.join(ROOT, 'lib/db'));

    // ---------- 1) قائمة الأدوات ----------
    console.log('\n📋 قائمة الأدوات:');
    const tl = await mcp('tools/list', {});
    const names = (tl.result.tools || []).map((t) => t.name);
    const expected = ['generate_image', 'edit_image', 'generate_video', 'text_to_speech', 'merge_videos', 'get_task', 'list_models', 'check_balance', 'list_media'];
    ok('عدد الأدوات = 9', names.length === 9, `الفعلي: ${names.length} → ${names.join(', ')}`);
    ok('الأسماء مطابقة تمامًا وبالترتيب', JSON.stringify(names) === JSON.stringify(expected), names.join(','));
    ok('لا توجد أدوات search/fetch/flow_*', !names.some((n) => n === 'search' || n === 'fetch' || n.startsWith('flow_')));
    const speechDef = tl.result.tools.find((t) => t.name === 'text_to_speech');
    ok('أداة text_to_speech: text إلزامية + mode/ref_audio/instruct موثقة',
      speechDef && speechDef.inputSchema.required.includes('text') && speechDef.inputSchema.properties.mode && speechDef.inputSchema.properties.ref_audio_url && speechDef.inputSchema.properties.instruct);
    const editDef = tl.result.tools.find((t) => t.name === 'edit_image');
    ok('أداة edit_image: image_url + image_urls موثقة',
      editDef && editDef.inputSchema.properties.image_url && editDef.inputSchema.properties.image_urls);

    // ---------- 2) النماذج والرصيد بلا مفاتيح ----------
    console.log('\n📦 النماذج والرصيد (بلا مفاتيح):');
    const lm = await callTool('list_models', {});
    ok('list_models يعمل بلا مفاتيح (سجل ثابت)', !lm.isError && lm.text.includes('Kokoro') && lm.text.includes('QwenImageEdit_Plus_NF4'), lm.text.slice(0, 120));
    ok('list_models يعرض المجموعات الأربع', ['توليد صورة من نص', 'تحرير صورة', 'فيديو من نص', 'تحويل النص إلى كلام'].every((s) => lm.text.includes(s)));
    const lmSpeech = await callTool('list_models', { type: 'speech' });
    ok('list_models type=speech يعرض موديلات الصوت فقط', !lmSpeech.isError && lmSpeech.text.includes('Kokoro') && !lmSpeech.text.includes('توليد صورة من نص'));
    const cb = await callTool('check_balance', {});
    ok('check_balance بلا مفاتيح → رسالة واضحة', cb.isError && cb.text.includes('لا توجد مفاتيح deAPI'));
    const bal = await http('/api/balance');
    ok('GET /api/balance بلا مفاتيح → keys: []', bal.status === 200 && Array.isArray(bal.data.keys) && bal.data.keys.length === 0);
    const modelsRest = await http('/api/models');
    ok('GET /api/models يتضمن edit وspeech وlive', modelsRest.status === 200 && modelsRest.data.edit && modelsRest.data.speech && 'live' in modelsRest.data);

    // ---------- 3) مفتاح وهمي → خط الأنابيب كاملًا دون تكلفة ----------
    // ملاحظة: المفتاح المرفوض (401) يُعطَّل تلقائيًا بعد المحاولة — سلوك السيرفر الصحيح؛
    // لذا نعيد إدراج مفتاح وهمي جديد قبل كل فحص خط أنابيب.
    console.log('\n🔑 مفتاح وهمي (يُرفض 401 من المزود — بلا تكلفة) للتحقق من بناء الطلبات:');
    const fakeKeyIds = [];
    async function addFake() {
      const r = await db.insertKey({ provider: 'deapi', api_key: FAKE_KEY + '-' + Math.random().toString(36).slice(2, 8), label: 'TEST-FAKE' });
      if (r.id) fakeKeyIds.push(r.id);
      return r;
    }

    await addFake();

    // نص → كلام: التحقق من بناء جسم audio/speech
    const tts = await callTool('text_to_speech', { text: 'Hello, this is a local test.', model: 'Kokoro', voice: 'af_sky', speed: 1.1, wait_seconds: 2 });
    ok('text_to_speech يعيد مهمة (قيد الانتظار بسبب المفتاح الوهمي)', tts.text.includes('task_id'), tts.text.slice(0, 100));
    let tid = (tts.text.match(/task_id: ([0-9a-f-]{36})/) || [])[1];
    if (tid) {
      testTaskIds.push(tid);
      const t = await db.getTask(tid);
      const p = JSON.parse(t.params_json || '{}');
      ok('جسم الصوت صحيح (model/text/lang/speed/format/sample_rate/voice)',
        p.model === 'Kokoro' && p.text === 'Hello, this is a local test.' && p.lang === 'en-us' && p.speed === 1.1 && p.format === 'mp3' && p.sample_rate === 24000 && p.voice === 'af_sky',
        JSON.stringify(p));
      ok('نوع المهمة speech وسجل المحاولات فيه رفض المفتاح', t.type === 'speech' && (t.attempts_json || '').includes('disabled'), (t.attempts_json || '').slice(0, 80));
    }

    // تحرير صورة: التحقق من بناء جسم images/edits (تنزيل الصورة ورفعها multipart)
    await addFake();
    const ed = await callTool('edit_image', { prompt: 'add a red hat', image_url: 'https://picsum.photos/64', wait_seconds: 2 });
    ok('edit_image يعيد مهمة', ed.text.includes('task_id'), ed.text.slice(0, 100));
    let eid = (ed.text.match(/task_id: ([0-9a-f-]{36})/) || [])[1];
    if (eid) {
      testTaskIds.push(eid);
      const t = await db.getTask(eid);
      const p = JSON.parse(t.params_json || '{}');
      ok('جسم التحرير صحيح (model/prompt/seed/image_url)',
        p.model === 'QwenImageEdit_Plus_NF4' && p.prompt === 'add a red hat' && p.seed === -1 && p.image_url === 'https://picsum.photos/64',
        JSON.stringify(p));
      ok('نوع المهمة edit', t.type === 'edit');
    }

    // صورة من نص: القيم الافتراضية مثبتة
    await addFake();
    const gi = await callTool('generate_image', { prompt: 'tiny local test', wait_seconds: 2 });
    let gid = (gi.text.match(/task_id: ([0-9a-f-]{36})/) || [])[1];
    if (gid) {
      testTaskIds.push(gid);
      const t = await db.getTask(gid);
      const p = JSON.parse(t.params_json || '{}');
      ok('جسم الصورة صحيح (ZImageTurbo 768×768 خطوات 8)', p.model === 'ZImageTurbo_INT8' && p.width === 768 && p.height === 768 && p.steps === 8 && p.seed === -1, JSON.stringify(p));
    }

    // فيديو من نص: المدة → إطارات ضمن الحدود
    await addFake();
    const gv = await callTool('generate_video', { prompt: 'tiny local test clip', duration: 2, wait_seconds: 2 });
    let vid = (gv.text.match(/task_id: ([0-9a-f-]{36})/) || [])[1];
    if (vid) {
      testTaskIds.push(vid);
      const t = await db.getTask(vid);
      const p = JSON.parse(t.params_json || '{}');
      ok('جسم الفيديو صحيح (LTX-2.5، المدة 2ث→49 إطار، fps 24)', p.model === 'Ltx2_5_22B_Dist_INT8' && p.frames === 49 && p.fps === 24 && p.width === 768, JSON.stringify(p));
    }

    // فيديو من صورة: image_url تنتقل لبناء multipart
    await addFake();
    const gv2 = await callTool('generate_video', { prompt: 'animate this', image_url: 'https://picsum.photos/128', wait_seconds: 2 });
    let vid2 = (gv2.text.match(/task_id: ([0-9a-f-]{36})/) || [])[1];
    if (vid2) {
      testTaskIds.push(vid2);
      const t = await db.getTask(vid2);
      const p = JSON.parse(t.params_json || '{}');
      ok('صورة→فيديو: image_url محفوظ في جسم الطلب', p.image_url === 'https://picsum.photos/128', JSON.stringify(p).slice(0, 120));
    }

    // ---------- 4) مسارات التحقق من المعطيات ----------
    console.log('\n🧪 التحقق من المعطيات:');
    const e1 = await callTool('edit_image', { prompt: 'no image given' });
    ok('edit_image بلا image_url → خطأ واضح', e1.isError && e1.text.includes('image_url'), e1.text.slice(0, 80));
    const e2 = await callTool('text_to_speech', {});
    ok('text_to_speech بلا نص → خطأ واضح', e2.isError && e2.text.includes('النص'), e2.text.slice(0, 80));
    const e3 = await callTool('generate_image', { prompt: '' });
    ok('generate_image بوصف فارغ → خطأ واضح', e3.isError && e3.text.includes('الوصف'), e3.text.slice(0, 80));
    const rest = await http('/api/generate', { method: 'POST', body: { type: 'banana', prompt: 'x' } });
    ok('REST type غير مدعوم → 400', rest.status === 400 && (rest.data.error || '').includes('speech'), JSON.stringify(rest.data).slice(0, 100));
    // مفتاح وهمي لفحص REST speech (المفاتيح السابقة عُطّلت بعد رفضها — سلوك السيرفر الصحيح)
    await addFake();
    const restSpeech = await http('/api/generate', { method: 'POST', body: { type: 'speech', prompt: 'Hello REST test', wait_seconds: 2 } });
    ok('REST speech مقبول ويعيد task', restSpeech.status === 200 && !!restSpeech.data.task && !!restSpeech.data.task.id, JSON.stringify(restSpeech.data).slice(0, 120));
    if (restSpeech.data.task) testTaskIds.push(restSpeech.data.task.id);
    // ---------- 5) get_task / list_media ----------
    console.log('\n🔎 التتبع والسجل:');
    if (tid) {
      const gt = await callTool('get_task', { task_id: tid });
      ok('get_task يجيب عن المهمة', gt.text.includes('task_id') || gt.text.includes('قيد'), gt.text.slice(0, 80));
    }
    const lmedia = await callTool('list_media', { limit: 5 });
    ok('list_media يعرض السجل', !lmedia.isError, lmedia.text.slice(0, 80));

    // ---------- 6) تنظيف ----------
    console.log('\n🧹 التنظيف:');
    for (const id of testTaskIds) await db.deleteTask(id);
    for (const id of fakeKeyIds) await db.deleteKey(id);
    ok(`حُذفت ${testTaskIds.length} مهمة تجريبية و${fakeKeyIds.length} مفتاح وهمي`, true);
    const pool = await db.getKeyPool(['deapi']);
    const leftoverFake = pool.filter((k) => k.api_key.includes('TEST') || (k.label || '').includes('TEST'));
    ok('القاعدة عادت بلا مفاتيح اختبار نشطة (المفاتيح الحقيقية تُستثنى)',
      leftoverFake.every((k) => k.status === 'disabled'),
      `مفاتيح اختبار متبقية: ${leftoverFake.length} · مفاتيح حقيقية نشطة: ${pool.length - leftoverFake.length}`);
  } finally {
    server.kill('SIGKILL');
  }

  console.log(`\n${'='.repeat(52)}`);
  console.log(`النتيجة: ✅ ${passed} ناجح · ❌ ${failed} فاشل`);
  if (failures.length) { console.log('\nالإخفاقات:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('💥 خطأ فادح:', e); process.exit(1); });
