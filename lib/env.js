// تحميل ملف .env يدويًا للمطابقة المحلية — على Vercel تأتي المتغيرات من لوحة التحكم
const fs = require('fs');
const path = require('path');

(function loadDotEnv() {
  try {
    const p = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch (e) { /* تجاهل — البيئة المحلية فقط */ }
})();

const req = (k) => process.env[k] || '';

module.exports = {
  // إلزاميان: قاعدة Turso (مناسب للـ serverless لأنه HTTP)
  TURSO_DATABASE_URL: req('TURSO_DATABASE_URL'),
  TURSO_AUTH_TOKEN: req('TURSO_AUTH_TOKEN'),
  // اختياري: خدمة دمج الفيديو الخارجية (Video Merger API v2)
  MERGER_API_BASE: (req('MERGER_API_BASE') || '').replace(/\/+$/, ''),
  // اختياري: حماية /mcp بمفتاح Bearer
  MCP_ACCESS_TOKEN: req('MCP_ACCESS_TOKEN'),
  // اختياري: حماية عمليات التعديل في الواجهة (المفاتيح/الحذف)
  ADMIN_TOKEN: req('ADMIN_TOKEN'),
  // مزود التوليد deAPI.ai
  DEAPI_BASE: req('DEAPI_BASE') || 'https://api.deapi.ai/api/v2',
  DEAPI_IMAGE_MODEL: req('DEAPI_IMAGE_MODEL') || 'ZImageTurbo_INT8',
  DEAPI_VIDEO_MODEL: req('DEAPI_VIDEO_MODEL') || 'Ltx2_5_22B_Dist_INT8',
  DEAPI_EDIT_MODEL: req('DEAPI_EDIT_MODEL') || 'QwenImageEdit_Plus_NF4',
  DEAPI_TTS_MODEL: req('DEAPI_TTS_MODEL') || 'Kokoro',
  // مزود Google Flow (Gemini API — Interactions API)
  GOOGLE_FLOW_BASE: req('GOOGLE_FLOW_BASE') || 'https://generativelanguage.googleapis.com',
  // نطاق عام لبناء روابط الوسيط /api/gf/ — يُستنتج تلقائيًا من Vercel عند النشر
  GOOGLE_FLOW_PUBLIC_BASE: (req('GOOGLE_FLOW_PUBLIC_BASE') || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  // الجسر المحلي لـ Google Flow (متصفح المستخدم على جهازه):
  // BRIDGE_TOKEN يحمي نقاط /api/flow/bridge (نفس القيمة في bridge.env المحلي)
  BRIDGE_TOKEN: req('BRIDGE_TOKEN'),
  // نطاق عام لبناء روابط /api/flow/file/ — يُستنتج تلقائيًا من Vercel عند النشر
  FLOW_PUBLIC_BASE: (req('FLOW_PUBLIC_BASE') || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  isProd: !!process.env.VERCEL,
};
