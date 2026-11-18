// lib/router.js — الموزع الموحد لكل مسارات الخادم.
// دالة واحدة على Vercel (api/[[...path]].js) تخدم /api/* و /mcp —
// ضروري لحد خطة Hobby (12 وظيفة كحد أقصى) والحفاظ على كل الروابط الخارجية كما هي.
const ROUTES = [
  { re: /^\/api\/health$/, h: require('./routes/health') },
  { re: /^\/api\/models$/, h: require('./routes/models') },
  { re: /^\/api\/balance$/, h: require('./routes/balance') },
  { re: /^\/api\/generate$/, h: require('./routes/generate') },
  { re: /^\/api\/merge$/, h: require('./routes/merge') },
  { re: /^\/api\/keys$/, h: require('./routes/keys') },
  { re: /^\/api\/keys\/([^/]+)$/, h: require('./routes/keys-id'), id: true },
  { re: /^\/api\/tasks$/, h: require('./routes/tasks') },
  { re: /^\/api\/tasks\/([^/]+)$/, h: require('./routes/tasks-id'), id: true },
  { re: /^\/api\/gf\/([^/]+)$/, h: require('./routes/gf-id') },
  { re: /^\/api\/flow\/bridge$/, h: require('./routes/flow-bridge') },
  { re: /^\/api\/flow\/status$/, h: require('./routes/flow-status') },
  { re: /^\/api\/flow\/file\/([^/]+)$/, h: require('./routes/flow-file-id') },
  // /mcp مباشرة (ويصل أيضًا كـ /api/mcp عبر rewrite في vercel.json) — نفس المعالج
  { re: /^\/mcp$/, h: require('./routes/mcp') },
  { re: /^\/api\/mcp$/, h: require('./routes/mcp') },
];

const { cors, json } = require('./http');

async function handle(req, res) {
  const pathname = (req.url || '/').split('?')[0].replace(/(.+)\/$/, '$1'); // توحيد الشرطة الأخيرة

  // تحليل query مرة واحدة — على Vercel كان req.query يُحلل تلقائيًا، وهنا نضمنه في كل البيئات
  const q = {};
  try {
    const u = new URL(req.url, 'http://localhost');
    for (const [k, v] of u.searchParams) q[k] = v;
  } catch (e) { /* بلا query */ }

  for (const r of ROUTES) {
    const m = pathname.match(r.re);
    if (!m) continue;
    req.query = { ...q, ...(r.id ? { id: decodeURIComponent(m[1]) } : {}) };
    req.pathname = pathname;
    try {
      return await r.h(req, res);
    } catch (e) {
      // أي خطأ غير معالج من المعالج نفسه → 500 JSON موحد
      if (!res.headersSent) json(res, 500, { error: 'internal: ' + String(e.message).slice(0, 300), code: 'internal' });
      else { try { res.end(); } catch (e2) { /* مغلقة */ } }
      return;
    }
  }

  // مسار غير معروف
  json(res, 404, {
    error: 'المسار غير معروف: ' + pathname,
    hint: 'المتاح: /api/health · /api/models · /api/balance · /api/generate · /api/merge · /api/keys[/{id}] · /api/tasks[/{id}] · /api/gf/{id} · /api/flow/bridge · /api/flow/status · /api/flow/file/{id} · /mcp',
  });
}

module.exports = { handle };
