// محوّل مزود deAPI.ai — الأشكال هنا مقاسة فعليًا بالـ curl (لا حقل مخترع):
//   POST {BASE}/images/generations        (JSON)  → {"data":{"request_id":"..."}}
//   POST {BASE}/videos/generations        (JSON)  → {"data":{"request_id":"..."}}
//   POST {BASE}/videos/animations         (multipart، first_frame_image) → {"data":{"request_id":"..."}}
//   GET  {BASE}/jobs/{request_id}         → {"data":{status, progress, result_url, error_code, error_reason, retryable, price...}}
//   GET  {BASE}/models?limit=100          → {"data":[...], "meta":{"last_page":..}}
// حالات المهمة: pending → processing → (in_progress) → done | error
const { DEAPI_BASE } = require('./env');

class ProviderError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status; // يُستخدم في classifyProviderError
  }
}

function headers(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
}

// دمج رسالة الخطأ + أخطاء الحقول (نمط Laravel: {message, errors:{field:[..]}})
function flattenError(status, body) {
  let msg = '';
  try {
    const j = JSON.parse(body);
    msg = j.message || j.error || '';
    if (j.errors) {
      const parts = [];
      for (const [k, v] of Object.entries(j.errors)) parts.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      if (parts.length) msg = `${msg} (${parts.join('; ')})`.trim();
    }
    if (!msg) msg = body.slice(0, 300);
  } catch (e) { msg = body.slice(0, 300); }
  return new ProviderError(status, msg || `HTTP ${status}`);
}

async function deFetch(apiKey, path, { method = 'GET', json, form, timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const opts = { method, headers: headers(apiKey), signal: ctrl.signal };
    if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
    if (form !== undefined) { delete opts.headers['Content-Type']; opts.body = form; } // FormData يضبط الحد بنفسه
    const res = await fetch(DEAPI_BASE + path, opts);
    const text = await res.text();
    if (!res.ok) throw flattenError(res.status, text);
    return JSON.parse(text);
  } catch (e) {
    if (e.name === 'AbortError') throw new ProviderError(0, 'timeout: deAPI did not respond in time');
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(0, `network: ${e.message}`);
  } finally { clearTimeout(t); }
}

// ---------- إنشاء المهام ----------
async function createImageJob(apiKey, { model, prompt, width, height, steps, seed = -1, negative_prompt, enhance_prompt }) {
  const body = { model, prompt, width, height, seed };
  if (steps !== undefined && steps !== null) body.steps = steps;
  if (negative_prompt) body.negative_prompt = negative_prompt;
  if (enhance_prompt !== undefined) body.enhance_prompt = enhance_prompt;
  const r = await deFetch(apiKey, '/images/generations', { method: 'POST', json: body });
  const id = r && r.data && r.data.request_id;
  if (!id) throw new ProviderError(200, 'unexpected: missing data.request_id in response');
  return { providerTaskId: id };
}

// الفيديو: نص→فيديو عبر JSON، وصورة→فيديو عبر multipart (ننقل الصورة عازلة في الذاكرة فقط —
// لا تخزين على السيرفر ولا على القرص، قاعدة الروابط فقط تبقى في قاعدة البيانات)
async function createVideoJob(apiKey, { model, prompt, width, height, frames, fps, seed = -1, image_url }) {
  if (!image_url) {
    const body = { model, prompt, width, height, seed, frames, fps };
    const r = await deFetch(apiKey, '/videos/generations', { method: 'POST', json: body });
    const id = r && r.data && r.data.request_id;
    if (!id) throw new ProviderError(200, 'unexpected: missing data.request_id in response');
    return { providerTaskId: id };
  }
  // image-to-video: تنزيل الإطار الأول من الرابط العام ثم رفعه multipart (حد المزود 1KB–10MB)
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  let imgBuf;
  try {
    const res = await fetch(image_url, { signal: ctrl.signal });
    if (!res.ok) throw new ProviderError(400, `params: cannot fetch image_url (HTTP ${res.status})`);
    imgBuf = Buffer.from(await res.arrayBuffer());
    if (imgBuf.length < 1024 || imgBuf.length > 10 * 1024 * 1024) {
      throw new ProviderError(400, 'params: first frame image must be 1KB–10MB');
    }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(400, `params: cannot fetch image_url: ${e.message}`);
  } finally { clearTimeout(t); }

  const form = new FormData();
  form.append('model', String(model));
  form.append('prompt', String(prompt));
  form.append('width', String(width));
  form.append('height', String(height));
  form.append('frames', String(frames));
  form.append('fps', String(fps));
  form.append('seed', String(seed));
  const ct = 'image/png'; // المزود يقبل الصور الشائعة؛ الاسم بإزاحة png يكفي لتحديد النوع عنده
  form.append('first_frame_image', new Blob([imgBuf], { type: ct }), 'first-frame.png');
  const r = await deFetch(apiKey, '/videos/animations', { method: 'POST', form });
  const id = r && r.data && r.data.request_id;
  if (!id) throw new ProviderError(200, 'unexpected: missing data.request_id in response');
  return { providerTaskId: id };
}

// ---------- حالة المهمة ----------
// توحيد الاستجابة: {status: 'processing'|'completed'|'failed', progress, urls, error, retryable}
async function checkJob(apiKey, providerTaskId) {
  const r = await deFetch(apiKey, `/jobs/${providerTaskId}`);
  const d = (r && r.data) || {};
  if (d.status === 'done') {
    const urls = d.result_url ? [d.result_url] : [];
    return { status: 'completed', progress: 100, urls };
  }
  if (d.status === 'error') {
    const msg = [d.error_code, d.error_reason].filter(Boolean).join(': ') || 'unknown provider error';
    return { status: 'failed', progress: d.progress || 0, error: msg, retryable: !!d.retryable };
  }
  return { status: 'processing', progress: typeof d.progress === 'number' ? d.progress : 0 };
}

// ---------- كتالوج الموديلات الحي (مع كاش 10 دقائق داخل نسخة الدالة) ----------
let catalogCache = null, catalogAt = 0;
async function fetchCatalog(apiKey, { force = false } = {}) {
  if (!force && catalogCache && Date.now() - catalogAt < 10 * 60 * 1000) return catalogCache;
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const r = await deFetch(apiKey, `/models?limit=100&page=${page}`);
    const items = (r && r.data) || [];
    out.push(...items);
    const lp = r && r.meta && r.meta.last_page;
    if (!lp || page >= lp || !items.length) break;
  }
  catalogCache = out; catalogAt = Date.now();
  return out;
}

module.exports = { ProviderError, createImageJob, createVideoJob, checkJob, fetchCatalog };
