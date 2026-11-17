// GET /api/tasks?limit&type&status — أحدث المهام + الإحصائيات
const db = require('../lib/db');
const { cors, json } = require('../lib/http');

function shape(t) {
  let urls = [], attempts = [], params = {};
  try { urls = JSON.parse(t.result_urls_json || '[]'); } catch (e) {}
  try { attempts = JSON.parse(t.attempts_json || '[]'); } catch (e) {}
  try { params = JSON.parse(t.params_json || '{}'); } catch (e) {}
  return {
    id: t.id, provider: t.provider, provider_task_id: t.provider_task_id, key_id: t.key_id,
    model: t.model, type: t.type, prompt: t.prompt, status: t.status, progress: t.progress,
    urls, attempts_count: attempts.length, attempts, params,
    error_message: t.error_message, created_at: t.created_at, updated_at: t.updated_at, completed_at: t.completed_at,
  };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'GET') { json(res, 405, { error: 'طريقة غير مسموحة — استخدم GET' }); return; }

  const q = req.query || {};
  const rows = await db.listRecentTasks(q.limit || 20, { type: q.type, status: q.status });
  const stats = await db.taskStats();
  json(res, 200, { tasks: rows.map(shape), stats });
};
