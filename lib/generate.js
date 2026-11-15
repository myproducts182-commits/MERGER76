// منسّق التوليد runGeneration — تدفق §6 من المواصفة:
// 1) توحيد اسم الموديل عبر aliases  2) جلب مسبحة المفاتيح بالترتيب الصارم
// 3) تسجيل المهمة في Turso قبل أي نداء خارجي  4) تجربة المرشحين بالتسلسل حتى نجاح الإنشاء
// 5) نافذة انتظار قصيرة مع بث التقدم  6) عند فشل منتصف المهمة بسبب مفتاح/رصيد:
//    إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي — العميل لا يرى شيئًا.
// 7) فشل على كل المفاتيح → المهمة تبقى processing وتُعاد مع كل get_task (تهدئة ~45 ثانية).
const db = require('./db');
const keysLib = require('./keys');
const models = require('./models');
const deapi = require('./deapi');
const merger = require('./merger');

class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// أنماط أخطاء المفتاح/الرصيد في منتصف المهمة (§4.3.2)
const KEY_BALANCE_RE = /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|exhausted|payment|invalid api key|invalid token|充值/i;

// النموذج المستخدم لا يرى أخطاء المفاتيح أو الرصيد أبدًا — تُستبدل برسالة محايدة
function sanitizeError(msg) {
  const s = String(msg || '');
  if (KEY_BALANCE_RE.test(s)) return 'خطأ مؤقت لدى المزود — تُعاد المحاولة تلقائيًا على مفتاح آخر';
  return s;
}

// حدود الموديل: من الكتالوج الحي إن توفر، وإلا القيم المقاسة الاحتياطية
async function limitsFor(def, apiKey) {
  const base = { ...(def.fallbackLimits || {}), ...(def.defaults || {}) };
  try {
    const catalog = await deapi.fetchCatalog(apiKey);
    const live = catalog.find((m) => m.slug === def.slug);
    if (live && live.info) {
      Object.assign(base, live.info.limits || {}, live.info.defaults || {}, live.info.features || {});
    }
  } catch (e) { /* كتالوج غير متاح — نستخدم الاحتياطي المقاس */ }
  return base;
}

// بناء معطيات الطلب الفعلية للمزود + تثبيتها داخل الحدود
async function buildProviderRequest(def, params, apiKey) {
  const lim = await limitsFor(def, apiKey);
  const p = params || {};

  if (def.type === 'image') {
    const mult = lim.dimension_multiple || 16;
    const width = models.clamp(p.width || def.defaults.width, lim.min_width || 128, lim.max_width || 2048, mult);
    const height = models.clamp(p.height || def.defaults.height, lim.min_height || 128, lim.max_height || 2048, mult);
    const body = {
      model: def.slug,
      prompt: String(p.prompt || '').slice(0, 4000),
      width, height,
      seed: Number.isFinite(Number(p.seed)) ? Math.trunc(Number(p.seed)) : -1,
    };
    if (lim.supports_steps !== false && (p.steps || def.defaults.steps)) {
      body.steps = models.clamp(p.steps || def.defaults.steps, lim.min_steps || 1, lim.max_steps || 50);
    }
    if (lim.supports_negative_prompt && p.negative_prompt) body.negative_prompt = String(p.negative_prompt).slice(0, 1000);
    if (p.enhance_prompt !== undefined) body.enhance_prompt = !!p.enhance_prompt;
    return body;
  }

  // فيديو
  const mult = lim.dimension_multiple || 64;
  let width, height;
  if (p.aspect_ratio && !p.width && !p.height) {
    const size = models.aspectToSize(p.aspect_ratio);
    if (size) { width = size.width; height = size.height; }
  }
  if (!width) width = models.clamp(p.width || def.defaults.width, lim.min_side || lim.min_width || 512, lim.max_side || lim.max_width || 1344, mult);
  if (!height) height = models.clamp(p.height || def.defaults.height, lim.min_side || lim.min_height || 512, lim.max_side || lim.max_height || 1344, mult);
  // التزامن مع حد البكسلات والنسبة عند توفرهما من الكتالوج
  if (lim.max_pixels && width * height > lim.max_pixels) {
    const scale = Math.sqrt(lim.max_pixels / (width * height));
    width = models.clamp(Math.floor(width * scale), lim.min_side || 512, lim.max_side || 1344, mult);
    height = models.clamp(Math.floor(height * scale), lim.min_side || 512, lim.max_side || 1344, mult);
  }
  if (lim.max_ratio) {
    let ratio = Math.max(width, height) / Math.min(width, height);
    if (ratio > lim.max_ratio) {
      if (width > height) width = models.clamp(height * lim.max_ratio, lim.min_side || 512, lim.max_side || 1344, mult);
      else height = models.clamp(width * lim.max_ratio, lim.min_side || 512, lim.max_side || 1344, mult);
    }
  }
  const fps = lim.max_fps && lim.min_fps && lim.max_fps === lim.min_fps ? lim.max_fps : (p.fps || def.defaults.fps || 24);
  const frames = p.frames
    ? models.clamp(p.frames, lim.min_frames || 49, lim.max_frames || 241)
    : (p.duration ? models.secondsToFrames(p.duration, def) : models.clamp(def.defaults.frames, lim.min_frames || 49, lim.max_frames || 241));
  const body = {
    model: def.slug,
    prompt: String(p.prompt || '').slice(0, 4096),
    width, height, frames, fps,
    seed: Number.isFinite(Number(p.seed)) ? Math.trunc(Number(p.seed)) : -1,
  };
  if (p.image_url) body.image_url = String(p.image_url); // صورة→فيديو (تُنقل multipart عازلة دون تخزين)
  return body;
}

// تجربة المرشحين بالتسلسل الصارم — أول نجاح يربط المهمة بالمفتاح
// returns: {ok, keyIndex} | {finalFail, message} | {noKeys, message}
async function attemptCreate(task, body, pool, startIdx, waitNote) {
  const attempts = [];
  for (let i = startIdx; i < pool.length; i++) {
    const key = pool[i];
    try {
      const created = (task.type === 'image')
        ? await deapi.createImageJob(key.api_key, body)
        : await deapi.createVideoJob(key.api_key, body);
      await keysLib.recordKeyAttempt(key, { ok: true });
      const attempt = { provider: 'deapi', keyId: key.id, keyLabel: keysLib.maskKey(key.api_key), ok: true, errorClass: null, error: null };
      await db.updateTask(task.id, {
        provider: 'deapi', provider_task_id: created.providerTaskId, key_id: key.id,
        status: 'processing', progress: 0, error_message: null,
      }, attempt);
      return { ok: true, keyIndex: i };
    } catch (e) {
      const cls = keysLib.classifyProviderError(e.status, e.message);
      await keysLib.recordKeyAttempt(key, { ok: false, errorClass: cls, error: String(e.message).slice(0, 500) });
      const attempt = { provider: 'deapi', keyId: key.id, keyLabel: keysLib.maskKey(key.api_key), ok: false, errorClass: cls, error: sanitizeError(e.message) };
      await db.updateTask(task.id, {}, attempt);
      attempts.push(cls);
      if (cls === 'params') {
        // تبديل المفاتيح لن يحل خطأ معطيات — فشل نهائي فوري
        await db.updateTask(task.id, { status: 'failed', error_message: sanitizeError(e.message) });
        return { finalFail: true, message: sanitizeError(e.message) };
      }
      // disabled / exhausted / provider / temporary → انتقل للمفتاح التالي فورًا
    }
  }
  // فشل على كل المفاتيح: تبقى processing (وليست failed) وتُعاد مع كل get_task
  await db.updateTask(task.id, { status: 'processing', error_message: 'بانتظار توفر مفتاح صالح… تُعاد المحاولة تلقائيًا' });
  return { noKeys: true };
}

// إعادة إنشاء نفس المهمة على المفتاح التالي غير المستخدم (فشل منتصف المهمة بسبب مفتاح/رصيد)
async function retryCreateOnNextKey(task, pool, body, lastKeyIndex) {
  return attemptCreate(task, body, pool, lastKeyIndex + 1);
}

// الفهرس الأخير الذي فشل — من سجل المحاولات
function lastFailedKeyIndex(task, pool) {
  let attempts = [];
  try { attempts = JSON.parse(task.attempts_json || '[]'); } catch (e) {}
  let idx = -1;
  for (const a of attempts) {
    const i = pool.findIndex((k) => k.id === a.keyId);
    if (i > idx) idx = i;
  }
  return idx;
}

// التدفق الرئيسي: يُستخدم من REST و MCP معًا
// onProgress(pct, message) تُستدعى كل نقطة استطلاع (~كل 3 ثوانٍ)
async function runGeneration({ type, modelName, params = {}, waitSeconds, onProgress }) {
  const def = modelName ? models.resolveModel(modelName) : models.resolveModel(defaultModelFor(type));
  if (!def) {
    throw new AppError('params', `❌ موديل غير معروف: ${modelName}. المتاح (صور): ${models.byType('image').map((m) => m.slug).join(', ')} — (فيديو): ${models.byType('video').map((m) => m.slug).join(', ')}`);
  }
  if (!params.prompt || !String(params.prompt).trim()) {
    throw new AppError('params', '❌ الوصف (prompt) مطلوب ولا يمكن أن يكون فارغًا.');
  }

  const pool = await db.getKeyPool(['deapi']);
  if (!pool.length) {
    throw new AppError('no_keys', `❌ لا توجد مفاتيح نشطة لخدمة ${def.slug}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`);
  }

  const body = await buildProviderRequest(def, params, pool[0].api_key);
  // تسجيل المهمة قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  const task = await db.insertTask({
    provider: 'deapi', model: def.slug, type,
    prompt: String(params.prompt || ''),
    paramsJson: JSON.stringify(body),
  });

  const wait = Math.max(0, Math.min(240, Number(waitSeconds !== undefined ? waitSeconds : (type === 'image' ? 90 : 25))));
  const deadline = Date.now() + wait * 1000;

  let created = await attemptCreate(task, body, pool, 0);
  if (created.finalFail) {
    const t = await db.getTask(task.id);
    throw new AppError('params', `❌ فشلت المهمة: ${created.message}`);
  }

  let activeKeyIndex = created.ok ? created.keyIndex : -1;
  let attemptsUsed = 1;

  // نافذة الانتظار: استطلاع كل 3 ثوانٍ مع بث التقدم
  while (created.ok && Date.now() < deadline) {
    await sleep(3000);
    let st;
    try {
      st = await deapi.checkJob(pool[activeKeyIndex].api_key, task.provider_task_id || (await db.getTask(task.id)).provider_task_id);
    } catch (e) {
      const cls = keysLib.classifyProviderError(e.status, e.message);
      if (cls === 'exhausted' || cls === 'disabled') {
        // فشل منتصف المهمة بسبب مفتاح/رصيد → إعادة إنشاء بنفس task_id على المفتاح التالي
        const cur = await db.getTask(task.id);
        const r = await retryCreateOnNextKey(cur, pool, body, activeKeyIndex);
        if (r.ok) { activeKeyIndex = r.keyIndex; attemptsUsed++; if (onProgress) onProgress(1, 'أُعيدت المهمة على مفتاح بديل — قيد التوليد…'); continue; }
        if (r.finalFail) throw new AppError('params', `❌ فشلت المهمة: ${r.message}`);
        return await db.getTask(task.id); // لا مفاتيح متبقية — تبقى processing وتُعاد لاحقًا
      }
      // temporary → استمر بالاستطلاع حتى نهاية النافذة
      continue;
    }
    if (st.status === 'completed') {
      const t = await db.updateTask(task.id, { status: 'completed', progress: 100, result_urls_json: JSON.stringify(st.urls) });
      if (onProgress) onProgress(100, 'اكتمل التوليد');
      return t;
    }
    if (st.status === 'failed') {
      if (KEY_BALANCE_RE.test(st.error || '') || st.retryable) {
        const cur = await db.getTask(task.id);
        const r = await retryCreateOnNextKey(cur, pool, body, lastFailedKeyIndex(cur, pool));
        if (r.ok) { activeKeyIndex = r.keyIndex; attemptsUsed++; if (onProgress) onProgress(1, 'أُعيدت المهمة على مفتاح بديل — قيد التوليد…'); continue; }
        if (r.finalFail) throw new AppError('params', `❌ فشلت المهمة: ${r.message}`);
        return await db.getTask(task.id);
      }
      const t = await db.updateTask(task.id, { status: 'failed', error_message: sanitizeError(st.error) });
      throw new AppError('params', `❌ فشلت المهمة: ${sanitizeError(st.error)}`);
    }
    await db.updateTask(task.id, { status: 'processing', progress: st.progress });
    if (onProgress) onProgress(st.progress, `قيد التوليد… ${st.progress}%`);
  }

  // انتهت النافذة والنتيجة لم تظهر → تُعاد processing مع task_id ويتابع العميل بـ get_task
  return await db.getTask(task.id);
}

// get_task — يحدّث المهمة الجارية حية من المزود/خدمة الدمج ثم يرجعها
async function refreshTask(taskId) {
  const task = await db.getTask(taskId);
  if (!task) return null;
  if (task.status === 'completed' || task.status === 'failed') return task;

  if (task.provider === 'merger') return refreshMergeTask(task);

  // deapi: مهمة بلا مزود بعد (بانتظار مفتاح) → إعادة المحاولة بعد تهدئة 45 ثانية
  if (!task.provider_task_id) {
    const last = db.parseSqliteDate(task.updated_at) || new Date(0);
    if (Date.now() - last.getTime() < 45000) return task;
    const pool = await db.getKeyPool(['deapi']);
    if (!pool.length) return task;
    let body = {};
    try { body = JSON.parse(task.params_json || '{}'); } catch (e) {}
    const r = await attemptCreate(task, body, pool, lastFailedKeyIndex(task, pool) + 1);
    if (r.ok) {
      // بعد إعادة الإنشاء نمنحها نافذة استطلاع قصيرة داخل get_task نفسه
      return await pollOnceAndMaybeWait(await db.getTask(task.id), pool, r.keyIndex, 12);
    }
    return await db.getTask(task.id);
  }

  const pool = await db.getKeyPool(['deapi']);
  const key = pool.find((k) => k.id === task.key_id) || pool[0];
  if (!key) return task;
  return pollOnceAndMaybeWait(task, pool, pool.indexOf(key), 12);
}

// استطلاع واحد + نافذة قصيرة إضافية إن كانت لا تزال قيد المعالجة
async function pollOnceAndMaybeWait(task, pool, keyIndex, extraWaitSec) {
  const deadline = Date.now() + extraWaitSec * 1000;
  let cur = task;
  let activeKeyIndex = keyIndex;
  let body = {};
  try { body = JSON.parse(cur.params_json || '{}'); } catch (e) {}

  while (Date.now() < deadline) {
    let st;
    try {
      st = await deapi.checkJob(pool[activeKeyIndex].api_key, cur.provider_task_id);
    } catch (e) {
      const cls = keysLib.classifyProviderError(e.status, e.message);
      if (cls === 'exhausted' || cls === 'disabled') {
        const r = await retryCreateOnNextKey(cur, pool, body, lastFailedKeyIndex(cur, pool));
        if (r.ok) { activeKeyIndex = r.keyIndex; cur = await db.getTask(cur.id); continue; }
        if (r.finalFail) return db.getTask(cur.id);
        return db.getTask(cur.id);
      }
      return db.getTask(cur.id); // temporary → العميل يعيد الاستطلاع لاحقًا
    }
    if (st.status === 'completed') {
      return db.updateTask(cur.id, { status: 'completed', progress: 100, result_urls_json: JSON.stringify(st.urls) });
    }
    if (st.status === 'failed') {
      if (KEY_BALANCE_RE.test(st.error || '') || st.retryable) {
        const r = await retryCreateOnNextKey(cur, pool, body, lastFailedKeyIndex(cur, pool));
        if (r.ok) { activeKeyIndex = r.keyIndex; cur = await db.getTask(cur.id); continue; }
        if (r.finalFail) return db.getTask(cur.id);
        return db.getTask(cur.id);
      }
      return db.updateTask(cur.id, { status: 'failed', error_message: sanitizeError(st.error) });
    }
    return db.updateTask(cur.id, { status: 'processing', progress: st.progress });
  }
  return db.getTask(cur.id);
}

// ---------- دمج الفيديو (§7.3) ----------
const processInFlight = new Set(); // قفل في الذاكرة حتى لا يتزامن process مع get_task

async function runMerge({ urls, taskIds, waitSeconds = 60, onProgress }) {
  const resolved = [];
  const failedIds = [];
  // روابط task_ids أولًا بنفس ترتيبها ثم urls المباشرة (§8)
  for (const tid of (taskIds || [])) {
    const t = await db.getTask(String(tid));
    if (!t || t.status !== 'completed') { failedIds.push(`${tid} (${t ? t.status : 'غير موجودة'})`); continue; }
    let u = [];
    try { u = JSON.parse(t.result_urls_json || '[]'); } catch (e) {}
    if (!u.length) { failedIds.push(`${tid} (بلا روابط)`); continue; }
    resolved.push(u[0]);
  }
  for (const u of (urls || [])) resolved.push(String(u));

  if (resolved.length < 2) {
    throw new AppError('params', '❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.' + (failedIds.length ? ` معرّفات غير صالحة: ${failedIds.join('، ')}` : ''));
  }
  if (resolved.length > 10) {
    throw new AppError('params', '❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).');
  }
  const bad = resolved.find((u) => !/^https?:\/\//i.test(u));
  if (bad) {
    throw new AppError('params', `❌ كل المقاطع يجب أن تكون روابط http/https مباشرة وعامة. رابط غير صالح: ${bad.slice(0, 80)}`);
  }

  const { MERGER_API_BASE } = require('./env');
  if (!MERGER_API_BASE) {
    throw new AppError('merger_unconfigured', '❌ خدمة الدمج غير مهيأة — اضبط متغير البيئة MERGER_API_BASE ثم أعد المحاولة.');
  }

  const task = await db.insertTask({
    provider: 'merger', model: 'video-merger', type: 'merge',
    prompt: `دمج ${resolved.length} مقاطع`,
    paramsJson: JSON.stringify({ videos: resolved }),
  });

  const deadline = Date.now() + Math.max(0, Math.min(240, Number(waitSeconds))) * 1000;
  let jobId = null;
  try {
    const job = await merger.createMergeJob(resolved);
    jobId = job.jobId;
    await db.updateTask(task.id, { provider_task_id: jobId, status: 'processing', progress: 5 });
  } catch (e) {
    await db.updateTask(task.id, { status: 'failed', error_message: sanitizeError(e.message) });
    throw new AppError('params', `❌ فشل إنشاء مهمة الدمج: ${sanitizeError(e.message)}`);
  }

  // إطلاق process خلفيًا وبمرة واحدة فقط (قفل الذاكرة)
  fireProcessOnce(jobId, task.id);

  // نافذة الانتظار: استعلام كل 3 ثوانٍ مع تحديث الحالة في القاعدة فورًا
  let finalError = null;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const job = await merger.getJob(jobId);
      const st = merger.normalizeJob(job);
      if (st.status === 'completed') {
        const t = await db.updateTask(task.id, { status: 'completed', progress: 100, result_urls_json: JSON.stringify(st.urls) });
        if (onProgress) onProgress(100, 'اكتمل الدمج');
        return t;
      }
      if (st.status === 'failed') {
        // خطأ HTTP معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
        finalError = st.error;
        break;
      }
      await db.updateTask(task.id, { status: 'processing', progress: Math.max(5, st.progress) });
      if (onProgress) onProgress(st.progress, `قيد الدمج… ${st.progress}%`);
    } catch (e) {
      // أخطاء شبكتنا نحن = مؤقتة → استمر بالاستعلام حتى انتهاء النافذة
      continue;
    }
  }
  if (finalError) {
    await db.updateTask(task.id, { status: 'failed', error_message: sanitizeError(finalError) });
    throw new AppError('params', `❌ فشلت المهمة: ${sanitizeError(finalError)}`);
  }
  return await db.getTask(task.id);
}

async function fireProcessOnce(jobId, taskId) {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  (async () => {
    try {
      const r = await merger.triggerProcess(jobId);
      if (r && r.error && r.final) {
        await db.updateTask(taskId, { status: 'failed', error_message: sanitizeError(r.error) });
      } else if (r && r.status === 'done') {
        const st = merger.normalizeJob(r);
        if (st.status === 'completed') {
          await db.updateTask(taskId, { status: 'completed', progress: 100, result_urls_json: JSON.stringify(st.urls) });
        }
      }
    } catch (e) { /* مؤقت — get_task سيستكمل الاستعلام لاحقًا */ }
    finally {
      const tt = setTimeout(() => processInFlight.delete(jobId), 120000);
      if (tt.unref) tt.unref();
    }
  })();
}

// تحديث مهمة دمج جارية من خدمة الدمج (get_task)
async function refreshMergeTask(task) {
  const { MERGER_API_BASE } = require('./env');
  if (!MERGER_API_BASE) return task;
  if (!task.provider_task_id) return task;

  const done = processInFlight.has(task.provider_task_id);
  if (!done) fireProcessOnce(task.provider_task_id, task.id); // لم يُنفَّذ process بعد → نفّذه الآن

  try {
    const job = await merger.getJob(task.provider_task_id);
    if (job.notFound) {
      return db.updateTask(task.id, { status: 'failed', error_message: 'مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)' });
    }
    const st = merger.normalizeJob(job);
    if (st.status === 'completed') {
      return db.updateTask(task.id, { status: 'completed', progress: 100, result_urls_json: JSON.stringify(st.urls) });
    }
    if (st.status === 'failed') {
      return db.updateTask(task.id, { status: 'failed', error_message: sanitizeError(st.error) });
    }
    return db.updateTask(task.id, { status: 'processing', progress: Math.max(5, st.progress) });
  } catch (e) {
    return task; // خطأ شبكة مؤقت — العميل يعيد لاحقًا
  }
}

function defaultModelFor(type) {
  const { DEAPI_IMAGE_MODEL, DEAPI_VIDEO_MODEL } = require('./env');
  return type === 'video' ? DEAPI_VIDEO_MODEL : DEAPI_IMAGE_MODEL;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { AppError, runGeneration, refreshTask, runMerge, sanitizeError };
