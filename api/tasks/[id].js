// GET /api/tasks/{id} — المهمة بعد التحديث الحي من المزود/خدمة الدمج
// DELETE /api/tasks/{id} — حذف المهمة (تنظيف)
const db = require('../../lib/db');
const generate = require('../../lib/generate');
const { cors, json, adminOk } = require('../../lib/http');
const env = require('../../lib/env');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  const id = String(req.query.id || '');

  if (req.method === 'GET') {
    const t = await generate.refreshTask(id);
    if (!t) { json(res, 404, { error: 'المهمة غير موجودة.' }); return; }
    let urls = [], attempts = [], params = {};
    try { urls = JSON.parse(t.result_urls_json || '[]'); } catch (e) {}
    try { attempts = JSON.parse(t.attempts_json || '[]'); } catch (e) {}
    try { params = JSON.parse(t.params_json || '{}'); } catch (e) {}
    return json(res, 200, {
      task: {
        id: t.id, provider: t.provider, provider_task_id: t.provider_task_id, key_id: t.key_id,
        model: t.model, type: t.type, prompt: t.prompt, status: t.status, progress: t.progress,
        urls, attempts_count: attempts.length, attempts, params: { width: params.width, height: params.height, frames: params.frames, fps: params.fps, steps: params.steps },
        error_message: t.error_message, created_at: t.created_at, updated_at: t.updated_at, completed_at: t.completed_at,
      },
    });
  }

  if (req.method === 'DELETE') {
    if (!adminOk(req, env)) { json(res, 401, { error: 'مفتاح الإدارة غير صحيح (X-Admin-Token)' }); return; }
    const t = await db.getTask(id);
    if (!t) { json(res, 404, { error: 'المهمة غير موجودة.' }); return; }
    await db.deleteTask(id);
    return json(res, 200, { ok: true });
  }

  json(res, 405, { error: 'طريقة غير مسموحة' });
};
