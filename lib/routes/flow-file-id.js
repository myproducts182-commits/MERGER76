// GET /api/flow/file/{jobId} — وسيط عام لبث نتيجة Google Flow من الجسر المحلي:
// الجسر يرفع ملف النتيجة شرائح base64 بعد اكتمال التوليد →
// هذه الدالة تجمّعها وتبثها للعميل (متصفح/ChatGPT/خدمة الدمج) ثم تحذف الشرائح.
// meta الملف {name, mime, size, chunks} مخزنة في result_json للمهمة.
const db = require('../db');
const { cors } = require('../http');

const WAIT_MS = 50000; // مهلة انتظار رفع الملف من الجسر
const STEP_MS = 1500;

function fail(res, code, msg) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'GET') return fail(res, 405, 'طريقة غير مسموحة — استخدم GET');

  const id = (String(req.url || '').split('?')[0].match(/\/api\/flow\/file\/([^/?]+)/) || [])[1] || '';
  if (!id) return fail(res, 400, 'معرّف المهمة مطلوب');

  let job;
  try { job = await db.flowGetJob(decodeURIComponent(id)); } catch (e) { return fail(res, 500, 'خطأ في قاعدة البيانات'); }
  if (!job) return fail(res, 404, 'مهمة Google Flow غير موجودة');
  if (job.status !== 'completed') return fail(res, 409, `المهمة غير مكتملة بعد (الحالة: ${job.status})`);

  let result = null;
  try { result = job.result_json ? JSON.parse(job.result_json) : null; } catch (e) {}
  const file = result && result.file ? result.file : null;
  if (!file || !file.chunks) return fail(res, 410, 'لا يوجد ملف قابل للبث لهذه المهمة (قد تكون النتيجة معلومات فقط أو رابطًا خارجيًا)');

  const total = Number(file.chunks) || 0;
  const mime = file.mime || 'video/mp4';
  const name = file.name || `${job.id}.mp4`;

  // انتظار اكتمال الشرائح من الجسر المحلي
  const deadline = Date.now() + WAIT_MS;
  let have = 0;
  while (Date.now() < deadline) {
    have = await db.flowCountChunks(job.id);
    if (have >= total) break;
    await sleep(STEP_MS);
  }
  if (have < total) {
    return fail(res, 504, `الجسر المحلي لم يكمل رفع الملف (${have}/${total} شريحة). تأكد أن flow-bridge يعمل على جهازك ثم أعد المحاولة.`);
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${name.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, max-age=60');

  // بث الشرائح بالترتيب ثم حذفها لتحرير قاعدة البيانات
  try {
    for (let seq = 0; seq < total; seq++) {
      const b64 = await db.flowGetChunk(job.id, seq);
      if (!b64) throw new Error(`شريحة ${seq} مفقودة`);
      const buf = Buffer.from(b64, 'base64');
      if (!res.write(buf)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
    db.flowDeleteChunks(job.id).catch(() => {});
  } catch (e) {
    try { res.end(); } catch (e2) {}
  }
};
