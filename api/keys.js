// GET /api/keys — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey)
// POST /api/keys — إضافة مفتاح مع رفض التكرار لنفس المزود
const db = require('../lib/db');
const { maskKey } = require('../lib/keys');
const { sanitizeError } = require('../lib/generate');
const { cors, json, readJson, adminOk } = require('../lib/http');
const env = require('../lib/env');

const PROVIDERS = [
  { id: 'deapi', label: 'deAPI.ai', hint: 'sk-dp-… — من deapi.ai' },
  { id: 'google-flow', label: 'Google Flow', hint: 'AIza… — من aistudio.google.com (فيديو فقط)' },
];

function shape(k) {
  return {
    id: k.id, provider: k.provider, label: k.label, masked: maskKey(k.api_key),
    status: k.status, usage_count: k.usage_count, success_count: k.success_count,
    fail_count: k.fail_count, last_error: sanitizeError(k.last_error), last_used_at: k.last_used_at,
    last_checked_at: k.last_checked_at, created_at: k.created_at,
  };
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();

  if (req.method === 'GET') {
    const rows = await db.listKeys();
    return json(res, 200, { keys: rows.map(shape), providers: PROVIDERS.map((p) => p.id) });
  }

  if (req.method === 'POST') {
    if (!adminOk(req, env)) { json(res, 401, { error: 'مفتاح الإدارة غير صحيح (X-Admin-Token)' }); return; }
    const body = await readJson(req);
    const apiKey = String(body.api_key || '').trim();
    const provider = String(body.provider || 'deapi').toLowerCase();
    const label = String(body.label || '').slice(0, 100);
    if (!apiKey) { json(res, 400, { error: 'مفتاح API مطلوب.' }); return; }
    if (!PROVIDERS.some((p) => p.id === provider)) {
      json(res, 400, { error: `المزود غير مدعوم. المزودات المتاحة: ${PROVIDERS.map((p) => p.id).join('، ')}.` });
      return;
    }
    const r = await db.insertKey({ provider, api_key: apiKey, label });
    if (r.error === 'duplicate') { json(res, 409, { error: 'هذا المفتاح مضاف مسبقًا لنفس المزود.' }); return; }
    const k = await db.getKey(r.id);
    json(res, 201, { key: shape(k) });
    return;
  }

  json(res, 405, { error: 'طريقة غير مسموحة' });
};
