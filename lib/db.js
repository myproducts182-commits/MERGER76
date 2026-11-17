// طبقة قاعدة البيانات — Turso/libSQL عبر HTTP، مخطط ينشأ تلقائيًا عند أول وصول
const { execute, batch } = require('./turso');
const crypto = require('crypto');

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await batch([
    { sql: `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      provider TEXT,
      provider_task_id TEXT,
      key_id TEXT,
      model TEXT NOT NULL,
      type TEXT NOT NULL,
      prompt TEXT DEFAULT '',
      params_json TEXT DEFAULT '{}',
      status TEXT NOT NULL,
      progress INTEGER DEFAULT 0,
      result_urls_json TEXT,
      error_message TEXT,
      attempts_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT DEFAULT '',
      api_key TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      usage_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      last_checked_at TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS gf_files (
      task_id TEXT PRIMARY KEY,
      guri TEXT NOT NULL,
      mime TEXT DEFAULT 'video/mp4',
      created_at TEXT DEFAULT (datetime('now'))
    )` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_keys_order ON api_keys(created_at ASC, id ASC)` },
  ]);
  schemaReady = true;
}

// ---------- المهام ----------
async function insertTask({ provider = 'deapi', model, type, prompt = '', paramsJson = '{}' }) {
  await ensureSchema();
  const id = crypto.randomUUID();
  await execute(
    `INSERT INTO tasks (id, provider, model, type, prompt, params_json, status, progress)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)`,
    [id, provider, model, type, prompt, paramsJson]
  );
  return getTask(id);
}

async function getTask(id) {
  await ensureSchema();
  const rows = await execute(`SELECT * FROM tasks WHERE id = ?`, [id]);
  return rows[0] || null;
}

// patch جزئي + إلحاق محاولة + ضبط completed_at تلقائيًا عند الاكتمال
async function updateTask(id, patch = {}, attempt = null) {
  await ensureSchema();
  const cur = await getTask(id);
  if (!cur) return null;
  const sets = [];
  const args = [];
  const assign = (col, val) => { sets.push(`${col} = ?`); args.push(val); };

  if (patch.provider !== undefined) assign('provider', patch.provider);
  if (patch.provider_task_id !== undefined) assign('provider_task_id', patch.provider_task_id);
  if (patch.key_id !== undefined) assign('key_id', patch.key_id);
  if (patch.model !== undefined) assign('model', patch.model);
  if (patch.status !== undefined) assign('status', patch.status);
  if (patch.progress !== undefined) assign('progress', Math.max(0, Math.min(100, Math.round(patch.progress))));
  if (patch.result_urls_json !== undefined) assign('result_urls_json', patch.result_urls_json);
  if (patch.error_message !== undefined) assign('error_message', patch.error_message);

  // سجل المحاولات: {provider,keyId,keyLabel,ok,errorClass,error,at}
  let attempts = [];
  try { attempts = JSON.parse(cur.attempts_json || '[]'); } catch (e) { attempts = []; }
  if (attempt) attempts.push({ ...attempt, at: new Date().toISOString() });
  assign('attempts_json', JSON.stringify(attempts));

  const status = patch.status !== undefined ? patch.status : cur.status;
  if (status === 'completed') assign('completed_at', datetimeNow());
  sets.push(`updated_at = datetime('now')`);
  args.push(id);
  await execute(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, args);
  return getTask(id);
}

async function listRecentTasks(limit = 20, { type, status } = {}) {
  await ensureSchema();
  const lim = Math.max(1, Math.min(50, Number(limit) || 20));
  const where = [];
  const args = [];
  if (type) { where.push('type = ?'); args.push(String(type)); }
  if (status) { where.push('status = ?'); args.push(String(status)); }
  const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ${lim}`;
  return execute(sql, args);
}

async function taskStats() {
  await ensureSchema();
  const rows = await execute(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const r = rows[0] || {};
  return {
    total: r.total || 0,
    completed: r.completed || 0,
    failed: r.failed || 0,
    processing: r.processing || 0,
  };
}

async function deleteTask(id) {
  await ensureSchema();
  await execute(`DELETE FROM tasks WHERE id = ?`, [id]);
}

// ---------- المفاتيح ----------
// الترتيب تسلسلي صارم حسب الإضافة (created_at ASC, id ASC) — ليس round-robin
async function insertKey({ provider = 'deapi', api_key, label = '' }) {
  await ensureSchema();
  const dup = await execute(`SELECT id FROM api_keys WHERE provider = ? AND api_key = ?`, [provider, api_key]);
  if (dup.length) return { error: 'duplicate' };
  const id = crypto.randomUUID();
  await execute(
    `INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, ?, ?, ?, 'active')`,
    [id, provider, label, api_key]
  );
  return { id };
}

async function listKeys() {
  await ensureSchema();
  return execute(`SELECT * FROM api_keys ORDER BY created_at ASC, id ASC`);
}

async function getKey(id) {
  await ensureSchema();
  const rows = await execute(`SELECT * FROM api_keys WHERE id = ?`, [id]);
  return rows[0] || null;
}

async function getKeyPool(providers = ['deapi']) {
  await ensureSchema();
  // المفتاح المستنزف يبقى في القائمة — الاستثناء الوحيد هو التعطيل اليدوي (disabled)
  const ph = providers.map(() => '?').join(', ');
  return execute(
    `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${ph}) ORDER BY created_at ASC, id ASC`,
    providers
  );
}

async function updateKey(id, patch = {}) {
  await ensureSchema();
  const cur = await getKey(id);
  if (!cur) return null;
  const sets = [];
  const args = [];
  for (const col of ['status', 'label', 'last_error', 'last_used_at', 'last_checked_at']) {
    if (patch[col] !== undefined) { sets.push(`${col} = ?`); args.push(patch[col]); }
  }
  for (const col of ['usage_count', 'success_count', 'fail_count']) {
    if (patch[col] !== undefined) { sets.push(`${col} = ?`); args.push(patch[col]); }
  }
  if (!sets.length) return cur;
  args.push(id);
  await execute(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`, args);
  return getKey(id);
}

// ---------- ملفات Google Flow ----------
// روابط Files API لدى Google تتطلب مفتاحًا للتنزيل — نخزّن الرابط الداخلي هنا
// ويُقدَّم للعالم عبر الوسيط /api/gf/{taskId}
async function saveGfFile(taskId, guri, mime = 'video/mp4') {
  await ensureSchema();
  await execute(
    `INSERT INTO gf_files (task_id, guri, mime) VALUES (?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET guri = excluded.guri, mime = excluded.mime`,
    [taskId, guri, mime]
  );
  return { taskId, guri };
}

async function getGfFile(taskId) {
  await ensureSchema();
  const rows = await execute(`SELECT * FROM gf_files WHERE task_id = ?`, [taskId]);
  return rows[0] || null;
}

async function deleteKey(id) {
  await ensureSchema();
  await execute(`DELETE FROM api_keys WHERE id = ?`, [id]);
}

function datetimeNow() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// تحويل 'YYYY-MM-DD HH:MM:SS' (UTC حسب sqlite) إلى Date
function parseSqliteDate(s) {
  if (!s) return null;
  const d = new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

module.exports = {
  ensureSchema, insertTask, getTask, updateTask, listRecentTasks, taskStats, deleteTask,
  insertKey, listKeys, getKey, getKeyPool, updateKey, deleteKey, datetimeNow, parseSqliteDate,
  saveGfFile, getGfFile,
};
