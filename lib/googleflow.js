// محوّل مزود Google Flow — عبر Gemini API الرسمية (Interactions API):
//   POST /v1beta/interactions       → إنشاء مهمة فيديو (interaction) — gemini-omni-1.2-flash
//   GET  /v1beta/interactions/{id}  → استطلاع الحالة: steps[].content[] تحمل uri أو base64
//   GET  /v1beta/files/{id}         → حالة ملف الفيديو (يجب أن يصبح ACTIVE قبل التنزيل)
//   POST /upload/v1beta/files       → رفع ملف بصيغة resumable (لنتائج base64 بدون رابط)
// المواصفة أدناه من الوثائق الرسمية aistudio.google.com/docs/omni (مسترجعة 2026-11):
//   المدة 3–15 ثانية بخطوة ثانية واحدة (افتراضي 10)، النسب 16:9/9:16،
//   الدقة 360p/720p/1080p/4k (افتراضي 720p)، delivery=uri يعيد رابط Files API
//   الذي يتطلب مفتاح API للتنزيل — لذا يُقدَّم للمستخدم عبر الوسيط /api/gf/{taskId}.
const { GOOGLE_FLOW_BASE, GOOGLE_FLOW_PUBLIC_BASE } = require('./env');

class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status; // يُستخدم في classifyProviderError
  }
}

function headers(apiKey) {
  return { 'x-goog-api-key': apiKey, Accept: 'application/json' };
}

// رسائل أخطاء Google: {error:{code, message, status}} أو نص عادي
function flattenError(status, body) {
  let msg = '';
  try {
    const j = JSON.parse(body);
    msg = (j.error && (j.error.message || j.error.status)) || j.message || '';
  } catch (e) { msg = ''; }
  if (!msg) msg = String(body || '').slice(0, 300);
  return new ProviderError(status, msg || `HTTP ${status}`);
}

async function gfFetch(apiKey, path, { method = 'GET', json, rawBody, extraHeaders, timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const opts = { method, headers: headers(apiKey), signal: ctrl.signal };
    if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
    if (rawBody !== undefined) { for (const [k, v] of Object.entries(extraHeaders || {})) opts.headers[k] = v; opts.body = rawBody; }
    const res = await fetch(GOOGLE_FLOW_BASE + path, opts);
    const text = await res.text();
    if (!res.ok) throw flattenError(res.status, text);
    return text ? JSON.parse(text) : {};
  } catch (e) {
    if (e.name === 'AbortError') throw new ProviderError(0, 'timeout: Google Flow did not respond in time');
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(0, `network: ${e.message}`);
  } finally { clearTimeout(t); }
}

// ---------- بناء طلب Interactions من المعطيات الموحدة ----------
// يُرجع جسم الطلب الرسمي: {model, input, response_format}
function buildRequest(def, params = {}, image = null) {
  const lim = def.fallbackLimits || {};
  const aspects = lim.aspects || ['16:9', '9:16'];
  const resolutions = lim.resolutions || ['360p', '720p', '1080p', '4k'];
  const prompt = String(params.prompt || '').slice(0, 4000);

  // النسبة: صريحة أو مستنبطة من الأبعاد أو 16:9 افتراضيًا
  let aspect = String(params.aspect_ratio || '').toLowerCase();
  if (aspect === 'auto' || !aspect) aspect = '';
  if (!aspects.includes(aspect)) {
    aspect = (params.width && params.height && Number(params.height) > Number(params.width)) ? '9:16' : '16:9';
  }
  if (!aspects.includes(aspect)) aspect = aspects[0];

  // المدة بالثواني: صريحة أو محسوبة من frames/fps أو الافتراضي (10 ثوانٍ)
  let sec = Number(params.duration);
  if (!Number.isFinite(sec) && params.frames) sec = Number(params.frames) / (Number(params.fps) || 24);
  if (!Number.isFinite(sec)) sec = (def.defaults && def.defaults.duration) || 10;
  sec = Math.max(lim.min_duration || 3, Math.min(lim.max_duration || 15, Math.round(sec)));

  // الدقة: صريحة من المسموح أو الافتراضي
  let resolution = String(params.resolution || '').toLowerCase();
  if (!resolutions.includes(resolution)) resolution = (def.defaults && def.defaults.resolution) || '720p';

  const body = {
    model: def.apiModel || 'gemini-omni-1.2-flash',
    input: prompt,
    response_format: { type: 'video', aspect_ratio: aspect, duration: `${sec}s`, resolution, delivery: 'uri' },
  };

  // صورة→فيديو: الإطار الأول base64 ضمن مصفوفة الإدخال (الشكل الرسمي الموثق)
  if (image && image.base64) {
    body.input = [
      { type: 'image', data: image.base64, mime_type: image.mime || 'image/jpeg' },
      { type: 'text', text: prompt },
    ];
  }
  return body;
}

// إنشاء مهمة فيديو — يعيد interaction.id كمعرّف مهمة المزود
async function createVideoJob(apiKey, body) {
  const r = await gfFetch(apiKey, '/v1beta/interactions', { method: 'POST', json: body });
  if (!r || !r.id) throw new ProviderError(200, 'unexpected: missing interaction id in response');
  return { providerTaskId: r.id };
}

// استخراج مخرج الفيديو من steps — الشكل الرسمي:
// steps[] → {type:'model_output', content:[{type:'video', mime_type, uri|data}]}
function extractVideo(interaction) {
  const steps = Array.isArray(interaction.steps) ? interaction.steps : [];
  for (const s of steps) {
    if (!s || s.type !== 'model_output') continue;
    const content = Array.isArray(s.content) ? s.content : [];
    for (const c of content) {
      if (!c || (c.type !== 'video' && c.mime_type !== 'video/mp4')) continue;
      const uri = c.uri || c.file_uri || c.video_uri || null;
      const data = c.data || c.data_base64 || null;
      if (uri || data) return { uri, data, mime: c.mime_type || 'video/mp4' };
    }
  }
  return null;
}

// حالة ملف Files API من رابطه — 'ACTIVE' | 'PROCESSING' | 'FAILED' | 'ACTIVE'(مفترض)
async function fileState(apiKey, uri) {
  const m = String(uri || '').match(/files\/([a-zA-Z0-9]+)/);
  if (!m) return 'ACTIVE'; // رابط غير قياسي — نفترض جهوزيته
  try {
    const r = await gfFetch(apiKey, `/v1beta/files/${m[1]}`);
    const st = r && r.state !== undefined ? r.state : (r && r.file && r.file.state);
    const name = typeof st === 'string' ? st : (st && st.name) || '';
    if (name.toUpperCase().includes('FAILED')) return 'FAILED';
    if (name.toUpperCase().includes('ACTIVE')) return 'ACTIVE';
    return 'PROCESSING';
  } catch (e) {
    return 'ACTIVE'; // تعذر الفحص — نترك التنزيل يحكم
  }
}

// توحيد الاستجابة: {status:'processing'|'completed'|'failed', progress, urls, base64Data?, mimeType?, error?, retryable?}
async function checkJob(apiKey, providerTaskId) {
  const r = await gfFetch(apiKey, `/v1beta/interactions/${encodeURIComponent(providerTaskId)}`);
  const status = String(r.status || '').toLowerCase();

  const done = status === 'completed' || status === 'succeeded' || status === 'done';
  const failed = status.includes('fail') || status.includes('error') || status.includes('cancel') || status === 'stopped';

  if (done) {
    const v = extractVideo(r);
    if (v && v.uri) {
      const fs = await fileState(apiKey, v.uri);
      if (fs === 'FAILED') return { status: 'failed', error: 'فشل تجهيز ملف الفيديو لدى Google', retryable: false };
      if (fs !== 'ACTIVE') return { status: 'processing', progress: 95 }; // الملف يُجهَّز لدى Files API
      return { status: 'completed', progress: 100, urls: [v.uri] };
    }
    if (v && v.data) {
      // نتيجة base64 مضمنة (بدون رابط) — تُرفع لاحقًا إلى Files API للحصول على رابط وسيط
      return { status: 'completed', progress: 100, urls: [], base64Data: v.data, mimeType: v.mime };
    }
    return { status: 'failed', error: 'اكتمل التفاعل لدى Google دون مخرج فيديو', retryable: false };
  }
  if (failed) {
    const em = (r.error && (r.error.message || r.error.status)) || (Array.isArray(r.steps) && r.steps.filter((s) => s && s.type === 'error').map((s) => (s.content || []).map((c) => c.text || '').join(' ')).join('; ')) || 'خطأ غير معروف لدى Google Flow';
    return { status: 'failed', progress: 0, error: em, retryable: false };
  }
  return { status: 'processing', progress: 0 };
}

// رفع بايتات فيديو إلى Files API (بروتوكول resumable الرسمي) — يعيد file.uri
async function uploadForUri(apiKey, buffer, mime = 'video/mp4') {
  const init = await fetch(GOOGLE_FLOW_BASE + '/upload/v1beta/files?uploadType=resumable', {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buffer.length),
      'X-Goog-Upload-Header-Content-Type': mime,
    },
    body: JSON.stringify({ file: { display_name: `merger76-${Date.now()}` } }),
  });
  const uploadUrl = init.headers.get('x-goog-upload-url');
  if (!init.ok || !uploadUrl) throw new ProviderError(init.status || 500, `files upload init failed: HTTP ${init.status}`);

  const fin = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(buffer.length),
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Type': mime,
    },
    body: buffer,
  });
  const text = await fin.text();
  if (!fin.ok) throw flattenError(fin.status, text);
  let j = {};
  try { j = JSON.parse(text); } catch (e) {}
  const uri = (j.file && j.file.uri) || j.uri;
  if (!uri) throw new ProviderError(200, 'unexpected: missing file.uri after upload');
  return uri;
}

// تنزيل الصورة (الإطار الأول) وتحويلها base64 — نفس عازلة الذاكرة فقط دون تخزين
async function fetchImageAsBase64(imageUrl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(imageUrl, { signal: ctrl.signal });
    if (!res.ok) throw new ProviderError(400, `params: cannot fetch image_url (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64 || buf.length > 10 * 1024 * 1024) {
      throw new ProviderError(400, 'params: first frame image must be 64B–10MB');
    }
    let mime = (res.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!/^image\/(png|jpeg|webp)$/.test(mime)) {
      // استنتاج من التوقيع
      if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
      else if (buf[0] === 0xff && buf[1] === 0xd8) mime = 'image/jpeg';
      else mime = 'image/jpeg';
    }
    return { base64: buf.toString('base64'), mime };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(400, `params: cannot fetch image_url: ${e.message}`);
  } finally { clearTimeout(t); }
}

// الرابط العام الوسيط لبث ملف المهمة — يُخزَّن في result_urls_json
function publicProxyUrl(taskId) {
  let base = GOOGLE_FLOW_PUBLIC_BASE
    || process.env.VERCEL_PROJECT_PRODUCTION_URL
    || process.env.VERCEL_URL
    || 'merger76.vercel.app';
  base = String(base).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `https://${base}/api/gf/${taskId}`;
}

module.exports = { ProviderError, buildRequest, createVideoJob, checkJob, uploadForUri, fetchImageAsBase64, publicProxyUrl };
