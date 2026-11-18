// POST /api/merge — دمج مقاطع عبر خدمة الدمج الخارجية (MERGER_API_BASE)
// الجسم: {urls: [...]} أو {task_ids: [...]} أو الاثنان (task_ids تُحل أولًا)
const generate = require('../generate');
const { cors, json, readJson } = require('../http');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'POST') { json(res, 405, { error: 'طريقة غير مسموحة — استخدم POST' }); return; }

  let b;
  try { b = await readJson(req); } catch (e) { json(res, 400, { error: 'جسم الطلب ليس JSON صالحًا.' }); return; }

  try {
    const task = await generate.runMerge({
      urls: Array.isArray(b.urls) ? b.urls : undefined,
      taskIds: Array.isArray(b.task_ids) ? b.task_ids : undefined,
      waitSeconds: Math.min(50, b.wait_seconds === undefined ? 45 : Number(b.wait_seconds) || 0),
    });
    let urls = [];
    try { urls = JSON.parse(task.result_urls_json || '[]'); } catch (e) {}
    json(res, 200, { task: { id: task.id, status: task.status, progress: task.progress, urls } });
  } catch (e) {
    if (e.code === 'merger_unconfigured') { json(res, 501, { error: e.message, code: e.code }); return; }
    if (e.code === 'params') { json(res, 400, { error: e.message, code: e.code }); return; }
    json(res, 500, { error: generate.sanitizeError(e.message), code: 'internal' });
  }
};
