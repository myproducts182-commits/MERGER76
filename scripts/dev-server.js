// خادم تطوير محلي يحاكي بيئة Vercel:
// - يخدم الملفات الثابتة من public/
// - يحلّل المسارات الديناميكية /api/keys/{id} و /api/tasks/{id} ويضعها في req.query.id
// - يوجّه /mcp → api/mcp.js
// التشغيل: node scripts/dev-server.js  (افتراضيًا على المنفذ 3000)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

const routes = {
  '/api/health': ROOT + '/api/health.js',
  '/api/models': ROOT + '/api/models.js',
  '/api/keys': ROOT + '/api/keys.js',
  '/api/tasks': ROOT + '/api/tasks.js',
  '/api/generate': ROOT + '/api/generate.js',
  '/api/merge': ROOT + '/api/merge.js',
  '/mcp': ROOT + '/api/mcp.js',
};
const dynamic = [
  { re: /^\/api\/keys\/([^/]+)$/, file: ROOT + '/api/keys/[id].js' },
  { re: /^\/api\/tasks\/([^/]+)$/, file: ROOT + '/api/tasks/[id].js' },
];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(req, res) {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, 'public', path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); return res.end('forbidden'); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  try {
    let handlerPath = routes[urlPath];
    for (const d of dynamic) {
      const m = urlPath.match(d.re);
      if (m) { req.query = { ...(req.query || {}), id: decodeURIComponent(m[1]) }; handlerPath = d.file; break; }
    }
    if (!handlerPath) return serveStatic(req, res);
    const mod = require(handlerPath);
    return await mod(req, res);
  } catch (e) {
    console.error('[dev-server]', urlPath, e);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); }
    res.end(JSON.stringify({ error: 'internal: ' + e.message }));
  }
});

server.listen(PORT, () => console.log(`✅ خادم التطوير يعمل على http://localhost:${PORT} — الواجهة: / والخادم: /mcp`));
