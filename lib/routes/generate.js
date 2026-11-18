// POST /api/generate — بدء توليد (صورة / تحرير صورة / فيديو / تحويل نص لكلام) — نفس محرك MCP تمامًا
// الجسم: {type: "image"|"edit"|"video"|"speech", prompt|text, model?, width?, height?, aspect_ratio?, steps?,
//         frames?, duration?, image_url?, image_urls?, guidance?, negative_prompt?, seed?,
//         lang?, voice?, speed?, mode?, instruct?, ref_audio_url?, format?, sample_rate?, wait_seconds?}
// يعيد المهمة: مكتملة مع urls أو جارية مع task_id (تتابعها من GET /api/tasks/{id})
const generate = require('../generate');
const { cors, json, readJson } = require('../http');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'POST') { json(res, 405, { error: 'طريقة غير مسموحة — استخدم POST' }); return; }

  let b;
  try { b = await readJson(req); } catch (e) { json(res, 400, { error: 'جسم الطلب ليس JSON صالحًا.' }); return; }

  const type = String(b.type || '').toLowerCase();
  if (!['image', 'edit', 'video', 'speech'].includes(type)) {
    json(res, 400, { error: 'type يجب أن يكون "image" أو "edit" أو "video" أو "speech".' }); return;
  }
  if (!b.prompt || !String(b.prompt).trim()) {
    json(res, 400, { error: 'الوصف (prompt) مطلوب — وللصوت مرّر النص في prompt أو text.' }); return;
  }

  const params = {};
  for (const k of ['prompt', 'text', 'model', 'aspect_ratio', 'width', 'height', 'steps', 'guidance', 'frames', 'duration', 'image_url', 'image_urls', 'negative_prompt', 'seed', 'lang', 'voice', 'speed', 'mode', 'instruct', 'ref_audio_url', 'format', 'sample_rate']) {
    if (b[k] !== undefined) params[k] = b[k];
  }
  const wait = Math.min(50, b.wait_seconds === undefined ? (type === 'video' ? 25 : 40) : Number(b.wait_seconds) || 0);

  try {
    const task = await generate.runGeneration({ type, modelName: params.model, params, waitSeconds: wait });
    json(res, 200, { task: { id: task.id, status: task.status, progress: task.progress, type: task.type, model: task.model, urls: safeUrls(task) } });
  } catch (e) {
    if (e.code === 'no_keys') { json(res, 409, { error: e.message, code: e.code }); return; }
    if (e.code === 'params') { json(res, 400, { error: e.message, code: e.code }); return; }
    json(res, 500, { error: generate.sanitizeError(e.message), code: 'internal' });
  }
};

function safeUrls(t) {
  try { return JSON.parse(t.result_urls_json || '[]'); } catch (e) { return []; }
}
