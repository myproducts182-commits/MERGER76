// تعليق توثيقي أعلى الملف — نقاط deAPI المقاسة:
//   POST {BASE}/images/generations        (JSON)  → {"data":{"request_id":"..."}}
//   POST {BASE}/videos/generations        (JSON)  → {"data":{"request_id":"..."}}
//   POST {BASE}/videos/animations         (multipart، first_frame_image) → {"data":{"request_id":"..."}}
//   POST {BASE}/images/edits              (multipart، image|images[]) → {"data":{"request_id":"..."}}
//   POST {BASE}/audio/speech              (multipart، text/model/lang/speed/format/sample_rate/voice/mode) → {"data":{"request_id":"..."}}
//   GET  {BASE}/account/balance           → {"data":{"balance":..}} (يتطلب مفتاح Admin)
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

// تنزيل ملف من رابط عام إلى ذاكرة عازلة (الإطار الأول / صورة التحرير / صوت الاستنساخ) —
// لا تخزين على السيرفر ولا على القرص، النقل عازل في الذاكرة فقط
async function fetchRemoteBuffer(url, { min = 1024, max = 10 * 1024 * 1024, label = 'الملف', timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new ProviderError(400, `params: cannot fetch ${label} (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < min || buf.length > max) {
      throw new ProviderError(400, `params: ${label} size must be ~${Math.round(min / 1024)}KB–${Math.round(max / 1024 / 1024)}MB`);
    }
    return buf;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(400, `params: cannot fetch ${label}: ${e.message}`);
  } finally { clearTimeout(t); }
}

// الفيديو: نص→فيديو عبر JSON، وصورة→فيديو عبر multipart (الصورة تنزيل ورفع عازل —
// حد المزود 1KB–10MB)
async function createVideoJob(apiKey, { model, prompt, width, height, frames, fps, seed = -1, image_url }) {
  if (!image_url) {
    const body = { model, prompt, width, height, seed, frames, fps };
    const r = await deFetch(apiKey, '/videos/generations', { method: 'POST', json: body });
    const id = r && r.data && r.data.request_id;
    if (!id) throw new ProviderError(200, 'unexpected: missing data.request_id in response');
    return { providerTaskId: id };
  }
  const imgBuf = await fetchRemoteBuffer(image_url, { label: 'first frame image' });
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

// تحرير الصورة (صورة+نص→صورة): POST /images/edits — multipart بصورة واحدة (image)
// أو حتى 5 صور (images[]) — كل صورة 10MB كحد أقصى
async function createEditJob(apiKey, { model, prompt, seed = -1, steps, negative_prompt, width, height, guidance, image_url, image_urls }) {
  const urls = [];
  if (image_url) urls.push(String(image_url));
  if (Array.isArray(image_urls)) urls.push(...image_urls.map((u) => String(u)).filter(Boolean));
  if (!urls.length) throw new ProviderError(400, 'params: image_url مطلوب — أضف رابط الصورة المراد تحريرها');
  if (urls.length > 5) throw new ProviderError(400, 'params: الحد الأقصى 5 صور لطلب التحرير الواحد');
  const form = new FormData();
  form.append('model', String(model));
  form.append('prompt', String(prompt).slice(0, 4000));
  form.append('seed', String(seed));
  if (steps !== undefined && steps !== null) form.append('steps', String(steps));
  if (negative_prompt) form.append('negative_prompt', String(negative_prompt).slice(0, 1000));
  if (width !== undefined && width !== null) form.append('width', String(width));
  if (height !== undefined && height !== null) form.append('height', String(height));
  if (guidance !== undefined && guidance !== null) form.append('guidance', String(guidance));
  for (let i = 0; i < urls.length; i++) {
    const buf = await fetchRemoteBuffer(urls[i], { label: 'edit input image' });
    const field = urls.length > 1 ? 'images[]' : 'image';
    form.append(field, new Blob([buf], { type: 'image/png' }), `input-${i}.png`);
  }
  const r = await deFetch(apiKey, '/images/edits', { method: 'POST', form });
  const id = r && r.data && r.data.request_id;
  if (!id) throw new ProviderError(200, 'unexpected: missing data.request_id in response');
  return { providerTaskId: id };
}

// تحويل النص إلى كلام: POST /audio/speech — multipart غير متزامن (poll /jobs كما الصور)
// mode: custom_voice (افتراضي، voice إلزامي) / voice_clone (ref_audio من 5–15 ثانية، ≤15MB) / voice_design (instruct)
async function createSpeechJob(apiKey, { model, text, lang, speed = 1, format = 'mp3', sample_rate = 24000, voice, mode, instruct, ref_audio_url }) {
  const form = new FormData();
  form.append('model', String(model));
  form.append('text', String(text));
  form.append('lang', String(lang));
  form.append('speed', String(speed));
  form.append('format', String(format));
  form.append('sample_rate', String(sample_rate));
  if (mode) form.append('mode', String(mode));
  if (voice) form.append('voice', String(voice));
  if (instruct) form.append('instruct', String(instruct));
  if (ref_audio_url) {
    const buf = await fetchRemoteBuffer(ref_audio_url, { min: 10 * 1024, max: 15 * 1024 * 1024, label: 'ref_audio' });
    form.append('ref_audio', new Blob([buf], { type: 'audio/mpeg' }), 'reference.mp3');
  }
  const r = await deFetch(apiKey, '/audio/speech', { method: 'POST', form });
  const id = r && r.data && r.data.request_id;
  if (!id) throw new ProviderError(200, 'unexpected: missing data.request_id in response');
  return { providerTaskId: id };
}

// رصيد حساب deAPI (يستهلكه التوليد) — يتطلب مفتاحًا بصلاحية Admin وإلا 403 insufficient_permissions
async function fetchBalance(apiKey) {
  const r = await deFetch(apiKey, '/account/balance', { method: 'GET', timeoutMs: 20000 });
  const d = (r && r.data) || {};
  const b = Number(d.balance);
  if (!Number.isFinite(b)) throw new ProviderError(200, 'unexpected: missing data.balance in response');
  return b;
}

// ---------- حالة المهمة ----------
// توحيد الاستجابة: {status: 'processing'|'completed'|'failed', progress, urls, price, error, retryable}
async function checkJob(apiKey, providerTaskId) {
  const r = await deFetch(apiKey, `/jobs/${providerTaskId}`);
  const d = (r && r.data) || {};
  if (d.status === 'done') {
    const urls = d.result_url ? [d.result_url] : [];
    return { status: 'completed', progress: 100, urls, price: d.price || null };
  }
  if (d.status === 'error') {
    const msg = [d.error_code, d.error_reason].filter(Boolean).join(': ') || 'unknown provider error';
    return { status: 'failed', progress: d.progress || 0, error: msg, retryable: !!d.retryable };
  }
  return { status: 'processing', progress: typeof d.progress === 'number' ? d.progress : 0, price: d.price || null };
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

module.exports = { ProviderError, fetchRemoteBuffer, createImageJob, createVideoJob, createEditJob, createSpeechJob, checkJob, fetchCatalog, fetchBalance };
