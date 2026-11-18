// GET /api/flow/status — حالة جسر Google Flow للواجهة (عام، بدون أسرار)
const flow = require('../flow');
const { cors, json } = require('../http');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'GET') { json(res, 405, { error: 'طريقة غير مسموحة — استخدم GET' }); return; }
  try {
    const out = await flow.status();
    json(res, 200, out);
  } catch (e) {
    json(res, 200, { bridge: { online: false, lastSeen: null }, queue: { pendingCommands: 0, activeJobs: 0 }, recentJobs: [], hint: 'جداول flow غير مهيأة بعد — تتطلب أول اتصال.' });
  }
};
