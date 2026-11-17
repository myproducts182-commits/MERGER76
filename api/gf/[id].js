// GET /api/gf/{taskId} — وسيط بث فيديو Google Flow:
// روابط Files API لدى Google تتطلب مفتاح API للتنزيل ولا تصلح رابطًا عامًا —
// نجلب الملف هنا بمفتاح المهمة (دون كشفه) ونمرر البايتات كما هي للعميل/خدمة الدمج.
const db = require('../../lib/db');
const { GOOGLE_FLOW_BASE } = require('../../lib/env');
const { cors } = require('../../lib/http');

function fail(res, code, msg) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(msg);
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'GET') return fail(res, 405, 'طريقة غير مسموحة — استخدم GET');

  const id = (String(req.url || '').split('?')[0].match(/\/api\/gf\/([^/?]+)/) || [])[1] || '';
  if (!id) return fail(res, 400, 'معرّف المهمة مطلوب');

  let task, gf;
  try {
    task = await db.getTask(decodeURIComponent(id));
    gf = task && await db.getGfFile(task.id);
  } catch (e) { return fail(res, 500, 'خطأ في قاعدة البيانات'); }
  if (!task) return fail(res, 404, 'المهمة غير موجودة');
  if (!gf || !gf.guri) return fail(res, 410, 'رابط الملف غير متاح — انتهت صلاحيته لدى Google (~48 ساعة) أو لم تكتمل المهمة');

  // مفتاح الجلب: مفتاح المهمة أولًا ثم أي مفتاح Google Flow نشط
  let apiKey = null;
  try {
    const k = task.key_id && await db.getKey(task.key_id);
    if (k && k.provider === 'google-flow' && k.status !== 'disabled') apiKey = k.api_key;
    if (!apiKey) {
      const pool = await db.getKeyPool(['google-flow']);
      apiKey = (pool[0] && pool[0].api_key) || null;
    }
  } catch (e) { /* نحاول بلا مفتاح أدناه */ }
  if (!apiKey) return fail(res, 410, 'لا يوجد مفتاح Google Flow نشط لجلب الملف — أضف مفتاحًا من مدير المفاتيح');

  const url = gf.guri + (gf.guri.includes('?') ? '&' : '?') + 'alt=media';
  let upstream;
  try {
    upstream = await fetch(url, { headers: { 'x-goog-api-key': apiKey, Accept: 'video/mp4' } });
  } catch (e) { return fail(res, 502, 'تعذر الاتصال بخدمة Google'); }
  if (!upstream.ok) return fail(res, upstream.status === 404 || upstream.status === 410 ? 410 : 502, `الملف غير متاح لدى Google (HTTP ${upstream.status}) — يُحذف بعد ~48 ساعة`);

  res.statusCode = 200;
  res.setHeader('Content-Type', upstream.headers.get('content-type') || gf.mime || 'video/mp4');
  res.setHeader('Content-Disposition', `inline; filename="${task.id}.mp4"`);
  res.setHeader('Cache-Control', 'private, max-age=300');

  try {
    const { Readable } = require('stream');
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => { try { res.end(); } catch (e) {} });
    nodeStream.pipe(res);
  } catch (e) {
    // بديل: تجميع كامل ثم الإرسال (بيئات لا تدعم fromWeb)
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }
};
