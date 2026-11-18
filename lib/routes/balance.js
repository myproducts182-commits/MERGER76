// GET /api/balance — رصيد حسابات deAPI النشط لكل مفتاح (الرصيد الذي يستهلكه التوليد)
// قراءة الرصيد تتطلب مفتاحًا بصلاحية Admin لدى deAPI — المفاتيح بلا صلاحية تعمل للتوليد فقط.
const db = require('../db');
const deapi = require('../deapi');
const keys = require('../keys');
const { cors, json, adminOk } = require('../http');
const env = require('../env');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'GET') { json(res, 405, { error: 'طريقة غير مسموحة — استخدم GET' }); return; }
  if (!adminOk(req, env)) { json(res, 401, { error: 'غير مصرح — ترويسة X-Admin-Token مطلوبة' }); return; }

  const pool = await db.getKeyPool(['deapi']);
  const out = [];
  let total = 0, okCount = 0;
  for (const k of pool) {
    try {
      const b = await deapi.fetchBalance(k.api_key);
      total += b; okCount++;
      out.push({ masked: keys.maskKey(k.api_key), label: k.label || '', balance: b });
    } catch (e) {
      const noAdmin = e.status === 403 || /permission|admin/i.test(String(e.message));
      out.push({ masked: keys.maskKey(k.api_key), label: k.label || '', error: noAdmin ? 'بدون صلاحية Admin' : String(e.message).slice(0, 140) });
    }
  }
  json(res, 200, {
    keys: out,
    count: pool.length,
    readable: okCount,
    total: okCount ? Math.round(total * 1000) / 1000 : null,
    note: 'قراءة الرصيد تتطلب مفتاحًا بصلاحية Admin لدى deAPI.ai',
  });
};
