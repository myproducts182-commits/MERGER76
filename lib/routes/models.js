// GET /api/models — الكتالوج الحي من deAPI (مدموجًا مع سجلنا الثابت: أسماء ودية وحدود)
const db = require('../db');
const deapi = require('../deapi');
const models = require('../models');
const { cors, json } = require('../http');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'GET') { json(res, 405, { error: 'طريقة غير مسموحة — استخدم GET' }); return; }

  const image = models.byType('image').map((m) => ({ slug: m.slug, label: m.label, provider: m.provider || 'deapi', aliases: m.aliases, defaults: m.defaults, limits: m.fallbackLimits }));
  const edit = models.byType('edit').map((m) => ({ slug: m.slug, label: m.label, provider: m.provider || 'deapi', aliases: m.aliases, defaults: m.defaults, limits: m.fallbackLimits }));
  const video = models.byType('video').map((m) => ({ slug: m.slug, label: m.label, provider: m.provider || 'deapi', aliases: m.aliases, defaults: m.defaults, limits: m.fallbackLimits, featured: !!m.featured }));
  const speech = models.byType('speech').map((m) => ({ slug: m.slug, label: m.label, provider: m.provider || 'deapi', aliases: m.aliases, defaults: m.defaults, limits: m.fallbackLimits, featured: !!m.featured }));

  let live = null;
  try {
    const pool = await db.getKeyPool(['deapi']);
    if (pool.length) {
      const catalog = await deapi.fetchCatalog(pool[0].api_key);
      live = catalog.map((c) => {
        const info = c.info || {};
        const price = c.price !== undefined && c.price !== null ? c.price : info.price;
        const item = { slug: c.slug, name: c.name, inference_types: c.inference_types, status: c.status };
        if (price !== undefined) item.price = price;
        // للصوت: اللغات والأصوات المتاحة من الكتالوج الحي
        if (Array.isArray(c.inference_types) && c.inference_types.includes('txt2speech')) {
          if (Array.isArray(info.languages)) item.languages = info.languages;
          if (Array.isArray(info.voices)) item.voices = info.voices;
        }
        return item;
      });
    }
  } catch (e) { live = null; }

  json(res, 200, { image, edit, speech, video, live, providers: ['deapi', 'google-flow'], provider: 'multi' });
};
