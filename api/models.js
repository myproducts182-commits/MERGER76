// GET /api/models — الكتالوج الحي من deAPI (مدموجًا مع سجلنا الثابت: أسماء ودية وحدود)
const db = require('../lib/db');
const deapi = require('../lib/deapi');
const models = require('../lib/models');
const { cors, json } = require('../lib/http');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'GET') { json(res, 405, { error: 'طريقة غير مسموحة — استخدم GET' }); return; }

  const image = models.byType('image').map((m) => ({ slug: m.slug, label: m.label, aliases: m.aliases, defaults: m.defaults, limits: m.fallbackLimits }));
  const video = models.byType('video').map((m) => ({ slug: m.slug, label: m.label, aliases: m.aliases, defaults: m.defaults, limits: m.fallbackLimits, featured: !!m.featured }));

  let live = null;
  try {
    const pool = await db.getKeyPool(['deapi']);
    if (pool.length) {
      const catalog = await deapi.fetchCatalog(pool[0].api_key);
      live = catalog.map((c) => ({ slug: c.slug, name: c.name, inference_types: c.inference_types, status: c.status }));
    }
  } catch (e) { live = null; }

  json(res, 200, { image, video, live, provider: 'deapi.ai' });
};
