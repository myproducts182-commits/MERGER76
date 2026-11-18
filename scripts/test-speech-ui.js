// اختبار سريع لقسم الصوت في الواجهة: مرور lang/voice/speed عبر REST إلى جسم الطلب
const { spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 3101, BASE = `http://127.0.0.1:${PORT}`;
const FAKE = 'sk-dp-UI-TEST-' + Math.random().toString(36).slice(2, 8);

async function wait(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

(async () => {
  const server = spawn('node', [path.join(ROOT, 'scripts/dev-server.js')], { env: { ...process.env, PORT: String(PORT), MERGER_TEST_MODE: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
  let code = 1;
  try {
    if (!await wait()) throw new Error('server not up');
    const db = require(path.join(ROOT, 'lib/db'));
    const ins = await db.insertKey({ provider: 'deapi', api_key: FAKE, label: 'UI-TEST' });

    // POST من الواجهة بنفس الجسم الذي تبنيه generate() في تبويب الصوت
    const r = await fetch(BASE + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'speech', prompt: 'مرحبا هذا اختبار', model: 'Kokoro', lang: 'en-us', voice: 'af_sky', speed: 1.1 }),
    });
    const data = await r.json();
    const t = data.task;
    console.log('status:', r.status, '| task:', t && t.id, '| type:', t && t.type);
    if (!t) throw new Error('no task: ' + JSON.stringify(data));
    const row = await db.getTask(t.id);
    const p = JSON.parse(row.params_json || '{}');
    const pass =
      row.type === 'speech' && p.model === 'Kokoro' && p.text === 'مرحبا هذا اختبار' &&
      p.lang === 'en-us' && p.voice === 'af_sky' && p.speed === 1.1 && p.format === 'mp3' && p.sample_rate === 24000;
    console.log('params_json:', JSON.stringify(p));
    console.log(pass ? '✅ قسم الصوت في الواجهة يعمل ويمرر كل الحقول' : '❌ فشل تمرير الحقول');
    await db.deleteTask(t.id);
    if (ins.id) await db.deleteKey(ins.id);
    code = pass ? 0 : 1;
  } finally { server.kill('SIGKILL'); }
  process.exit(code);
})().catch((e) => { console.error('💥', e.message); process.exit(1); });
