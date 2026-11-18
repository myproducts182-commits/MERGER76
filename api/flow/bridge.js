// /api/flow/bridge — القناة الآمنة بين خادم Vercel والجسر المحلي على جهاز المستخدم:
//   GET (مع ?wait=1) — استطلاع طويل: يسحب الأمر المعلق التالي ويعلّمه 'sent'،
//                      ويحدّث نبض الجسر مع كل اتصال (كل اتصال = heartbeat).
//   POST — من الجسر: heartbeat (نبض + معلومات) | result (نتيجة أمر) | file_chunk (شريحة ملف).
// المصادقة: ترويسة X-Bridge-Token يجب أن تساوي متغير البيئة BRIDGE_TOKEN —
// نفس القيمة موجودة في bridge.env المحلي فقط؛ لا أسرار في الكود ولا في المستودع.
const db = require('../../lib/db');
const env = require('../../lib/env');
const { cors, json, readJson } = require('../../lib/http');

const LONG_POLL_MS = 38000; // أقل من maxDuration=60 مع هامش للعمل
const POLL_STEP_MS = 2000;

function authorized(req) {
  if (!env.BRIDGE_TOKEN) return { ok: false, reason: 'server-not-configured' };
  const t = String(req.headers['x-bridge-token'] || '');
  if (!t || t !== env.BRIDGE_TOKEN) return { ok: false, reason: 'bad-token' };
  return { ok: true };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();

  const auth = authorized(req);
  if (!auth.ok) {
    if (auth.reason === 'server-not-configured') {
      return json(res, 503, { error: 'BRIDGE_TOKEN غير مضبوط على الخادم — أضفه في Vercel ثم ضع القيمة نفسها في bridge.env المحلي.' });
    }
    return json(res, 401, { error: 'توكن الجسر غير صحيح (ترويسة X-Bridge-Token)' });
  }

  // ---------- GET: استطلاع طويل لأمر معلق ----------
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const wait = url.searchParams.get('wait') === '1';
    const deadline = Date.now() + (wait ? LONG_POLL_MS : 0);
    // كل اتصال GET يحدّث نبض الجسر تلقائيًا
    let touched = false;
    try {
      for (;;) {
        const cmd = await db.flowNextPendingCommand();
        if (cmd) {
          await db.flowMarkCommandSent(cmd.id);
          let payload = {};
          try { payload = JSON.parse(cmd.payload_json || '{}'); } catch (e) {}
          return json(res, 200, {
            command: { id: cmd.id, jobId: cmd.job_id, type: cmd.type, payload, createdAt: cmd.created_at },
          });
        }
        if (!wait || Date.now() >= deadline) break;
        await sleep(POLL_STEP_MS);
        touched = true;
        // تحديث النبض أثناء الانتظار أيضًا (كل دورة)
        try { await db.flowTouchBridge(); } catch (e) {}
      }
      if (!touched) await db.flowTouchBridge();
      return json(res, 200, { empty: true });
    } catch (e) {
      return json(res, 500, { error: 'flow bridge poll failed: ' + e.message });
    }
  }

  // ---------- POST: نبض/نتائج/شرائح ----------
  if (req.method === 'POST') {
    try {
      const body = await readJson(req);
      const type = String(body.type || '');

      if (type === 'heartbeat') {
        await db.flowTouchBridge(String(body.version || ''), JSON.stringify(body.info || {}));
        // تنظيف شرائح قديمة (أكبر من ساعتين) بشكل دوري رخيص
        if (Math.random() < 0.05) await db.flowDeleteOldChunks(2);
        return json(res, 200, { ok: true, serverTime: new Date().toISOString() });
      }

      if (type === 'result') {
        const id = String(body.command_id || '');
        if (!id) return json(res, 400, { error: 'command_id مطلوب' });
        const cmd = await db.flowGetCommand(id);
        if (!cmd) return json(res, 404, { error: 'الأمر غير موجود' });
        const ok = !!body.ok;
        await db.flowCompleteCommand(id, JSON.stringify(body.result ?? { ok: false, error: 'no result' }), !ok);
        if (cmd.job_id) {
          const r = body.result || {};
          await db.flowUpdateJob(cmd.job_id, {
            status: ok ? 'completed' : 'failed',
            progress: ok ? 100 : undefined,
            stage: ok ? 'اكتمل' : 'فشل',
            resultJson: JSON.stringify(r.result ?? r ?? null),
            error: ok ? null : String(r.error || body.error || 'فشل على الجهاز المحلي'),
          });
        }
        return json(res, 200, { ok: true });
      }

      if (type === 'progress') {
        const jobId = String(body.job_id || '');
        if (!jobId) return json(res, 400, { error: 'job_id مطلوب' });
        await db.flowUpdateJob(jobId, {
          status: body.status || 'running',
          progress: body.progress,
          stage: body.stage,
        });
        return json(res, 200, { ok: true });
      }

      if (type === 'file_chunk') {
        const jobId = String(body.job_id || '');
        const seq = Number(body.seq);
        const data = String(body.data || '');
        if (!jobId || !Number.isInteger(seq) || seq < 0 || !data) return json(res, 400, { error: 'file_chunk يحتاج job_id و seq و data' });
        await db.flowSaveChunk(jobId, seq, data);
        return json(res, 200, { ok: true, received: seq });
      }

      return json(res, 400, { error: 'نوع POST غير معروف — استخدم heartbeat أو result أو progress أو file_chunk' });
    } catch (e) {
      return json(res, 500, { error: 'flow bridge post failed: ' + e.message });
    }
  }

  json(res, 405, { error: 'طريقة غير مسموحة' });
};
