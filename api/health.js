// GET /api/health — فحص شامل: قاعدة البيانات، خدمة الدمج، الموديلات، جسر Google Flow
const db = require('../lib/db');
const { dbHealthy } = require('../lib/turso');
const merger = require('../lib/merger');
const models = require('../lib/models');
const env = require('../lib/env');
const flow = require('../lib/flow');
const { cors, json } = require('../lib/http');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'GET') { json(res, 405, { error: 'طريقة غير مسموحة — استخدم GET' }); return; }

  const healthy = await dbHealthy();
  const mHealthy = env.MERGER_API_BASE ? await merger.healthy() : false;
  const flowBridge = healthy ? await flow.healthSummary() : { online: false, lastSeen: null };

  json(res, healthy ? 200 : 503, {
    ok: healthy,
    database: healthy ? 'turso-connected' : 'turso-error',
    mcpEndpoint: '/mcp',
    providers: ['deapi', 'google-flow'],
    models: models.MODELS.map((m) => ({ canonical: m.slug, type: m.type, label: m.label, providers: [m.provider || 'deapi'] })),
    merger: { base: env.MERGER_API_BASE || null, configured: !!env.MERGER_API_BASE, healthy: mHealthy },
    flowBridge,
    authRequired: !!env.MCP_ACCESS_TOKEN,
    version: '1.6.0',
  });
};
