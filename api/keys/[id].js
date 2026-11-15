// PATCH /api/keys/{id} — تعطيل/تنشيط يدوي أو تعديل التسمية
// DELETE /api/keys/{id} — حذف نهائي
const db = require('../../lib/db');
const { maskKey } = require('../../lib/keys');
const { sanitizeError } = require('../../lib/generate');
const { cors, json, readJson, adminOk } = require('../../lib/http');
const env = require('../../lib/env');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  if (!adminOk(req, env)) { json(res, 401, { error: 'مفتاح الإدارة غير صحيح (X-Admin-Token)' }); return; }

  const id = String(req.query.id || '');

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const patch = {};
    if (body.status === 'disabled' || body.status === 'active') patch.status = body.status;
    if (body.label !== undefined) patch.label = String(body.label).slice(0, 100);
    const k = await db.updateKey(id, patch);
    if (!k) { json(res, 404, { error: 'المفتاح غير موجود.' }); return; }
    return json(res, 200, { key: { id: k.id, provider: k.provider, label: k.label, masked: maskKey(k.api_key), status: k.status } });
  }

  if (req.method === 'DELETE') {
    const k = await db.getKey(id);
    if (!k) { json(res, 404, { error: 'المفتاح غير موجود.' }); return; }
    await db.deleteKey(id);
    return json(res, 200, { ok: true, deleted: maskKey(k.api_key) });
  }

  json(res, 405, { error: 'طريقة غير مسموحة' });
};
