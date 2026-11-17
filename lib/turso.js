// عميل Turso (libSQL) عبر HTTP — بدون أي اعتماديات خارجية (fetch مدمج في Node 18+)
// مناسب تمامًا لبيئة Vercel serverless: لا ملفات SQLite محلية إطلاقًا.
const { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN } = require('./env');

function endpoint() {
  let u = TURSO_DATABASE_URL || '';
  if (u.startsWith('libsql://')) u = 'https://' + u.slice('libsql://'.length);
  else if (u.startsWith('wss://')) u = 'https://' + u.slice('wss://'.length);
  return u.replace(/\/+$/, '');
}

// ترميز المعطيات بصيغة Hrana (القيم دائمًا نصوص داخل JSON)
function encArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: String(v) };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  return { type: 'text', value: String(v) };
}

function decVal(c) {
  if (!c || c.type === 'null' || c.value === null || c.value === undefined) return null;
  switch (c.type) {
    case 'integer': return parseInt(c.value, 10);
    case 'float': return parseFloat(c.value);
    case 'text': return c.value;
    case 'boolean': return c.value === true;
    default: return c.value;
  }
}

async function pipeline(requests, timeoutMs = 20000) {
  const base = endpoint();
  if (!base || !TURSO_AUTH_TOKEN) throw new Error('TURSO_DATABASE_URL / TURSO_AUTH_TOKEN غير مضبوطة');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + '/v2/pipeline', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TURSO_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Turso HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    for (const r of data.results || []) {
      if (r.type === 'error') throw new Error(`Turso SQL: ${r.error && r.error.message}`);
    }
    return data.results || [];
  } finally { clearTimeout(t); }
}

// استعلام واحد → مصفوفة صفوف ككائنات
async function execute(sql, args = []) {
  const rs = await pipeline([{ type: 'execute', stmt: { sql, args: args.map(encArg) } }]);
  const resp = rs[0] && rs[0].response;
  if (!resp || resp.type === 'error') throw new Error((resp && resp.error && resp.error.message) || 'Turso execute failed');
  const result = resp.result || { cols: [], rows: [] };
  const cols = result.cols.map((c) => c.name);
  return result.rows.map((cells) => {
    const o = {};
    cols.forEach((n, i) => { o[n] = decVal(cells[i]); });
    return o;
  });
}

// تنفيذ دفعة أوامر (للمخطط والحذف الشامل)
async function batch(stmts) {
  const requests = stmts.map((s) => ({ type: 'execute', stmt: { sql: s.sql, args: (s.args || []).map(encArg) } }));
  const rs = await pipeline(requests);
  return rs.map((r) => r.response && r.response.result).filter(Boolean);
}

// فحص جهوزية قاعدة البيانات
async function dbHealthy() {
  try { await execute('SELECT 1'); return true; } catch (e) { return false; }
}

module.exports = { execute, batch, dbHealthy };
