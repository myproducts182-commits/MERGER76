// GET /api/health — فحص شامل: قاعدة البيانات، خدمة الدمج، الموديلات
const db = require('../lib/db');
const { dbHealthy } = require('../lib/turso');
const merger = require('../lib/merger');
const models = require('../lib/models');
const env = require('../lib/env');
const { cors, json } = require('../lib/http');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'GET') { json(res, 405, { error: 'طريقة غير مسموحة — استخدم GET' }); return; }

  const healthy = await dbHealthy();
  const mHealthy = env.MERGER_API_BASE ? await merger.healthy() : false;

  json(res, healthy ? 200 : 503, {
    ok: healthy,
    database: healthy ? 'turso-connected' : 'turso-error',
    mcpEndpoint: '/mcp',
    models: models.MODELS.map((m) => ({ canonical: m.slug, type: m.type, label: m.label, providers: ['deapi'] })),
    merger: { base: env.MERGER_API_BASE || null, configured: !!env.MERGER_API_BASE, healthy: mHealthy },
    authRequired: !!env.MCP_ACCESS_TOKEN,
    version: '1.2.0',
  });
};
