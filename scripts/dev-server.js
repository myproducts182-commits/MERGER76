// خادم تطوير محلي يحاكي بيئة Vercel:
// - كل مسارات /api/* و /mcp تمر عبر lib/router.js (نفس الموزع المستخدم في الإنتاج api/[[...path]].js)
// - يخدم الملفات الثابتة من public/
// التشغيل: node scripts/dev-server.js  (افتراضيًا على المنفذ 3000)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle } = require('../lib/router');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

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
  const p = req.url.split('?')[0];
  try {
    if (p === '/api' || p.startsWith('/api/') || p === '/mcp' || p.startsWith('/mcp/')) {
      return await handle(req, res);
    }
    return serveStatic(req, res);
  } catch (e) {
    console.error('[dev-server]', p, e);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); }
    res.end(JSON.stringify({ error: 'internal: ' + e.message }));
  }
});

server.listen(PORT, () => console.log(`✅ خادم التطوير يعمل على http://localhost:${PORT} — الواجهة: / والخادم: /mcp`));
