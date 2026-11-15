// مساعدات HTTP مشتركة لكل مسارات api/ — CORS مفتوح، قراءة الجسم، ردود JSON موحدة
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Mcp-Session-Id,X-Admin-Token');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function readBody(req, limitMB = 12) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitMB * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limitMB = 12) {
  const raw = await readBody(req, limitMB);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) {
    const err = new Error('invalid json');
    err.code = 'invalid_json';
    throw err;
  }
}

// حماية اختيارية لعمليات التعديل: إن ضُبط ADMIN_TOKEN يُطلب في الترويسة X-Admin-Token أو Authorization
function adminOk(req, env) {
  if (!env.ADMIN_TOKEN) return true; // غير مضبوط = مفتوح كما في المواصفة
  const t = (req.headers['x-admin-token'] || '').toString();
  const b = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').toString();
  return t === env.ADMIN_TOKEN || b === env.ADMIN_TOKEN;
}

module.exports = { cors, json, readBody, readJson, adminOk };
