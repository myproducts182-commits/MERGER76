// عميل خدمة دمج الفيديو الخارجية (Video Merger API v2) — عنوانها من MERGER_API_BASE
// بلا مفاتيح أو توثيق. المخرجات MP4 (H.264 + AAC). الحدود: 10 مقاطع كحد أقصى،
// 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد — والملفات تُحذف بعد 24 ساعة.
// روابط فقط أبدًا: لا ننزّل أي وسائط إلى سيرفرنا.
const { MERGER_API_BASE } = require('./env');

class MergerError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function mFetch(path, { method = 'GET', json, timeoutMs = 30000 } = {}) {
  if (!MERGER_API_BASE) throw new MergerError(0, 'no-base');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const opts = { method, headers: { Accept: 'application/json' }, signal: ctrl.signal };
    if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
    const res = await fetch(MERGER_API_BASE + path, opts);
    const text = await res.text();
    let body = {};
    try { body = JSON.parse(text); } catch (e) { body = { raw: text.slice(0, 200) }; }
    if (!res.ok) throw new MergerError(res.status, body.error || `HTTP ${res.status}`);
    return body;
  } catch (e) {
    if (e.name === 'AbortError') throw new MergerError(0, 'timeout');
    throw e;
  } finally { clearTimeout(t); }
}

// تحليل دفاعي للحالة (قسم 7.2): قد يرد الجسم فيه error بدون status → فشل فورًا،
// وقد يأتي progress كسرًا 0..1 → يُضرب في 100.
const DONE_RE = /^(done|completed|complete|success|succeeded|finished)$/i;
const FAIL_RE = /^(error|failed|failure|cancelled)$/i;

function normalizeJob(job) {
  if (!job) return { status: 'processing', progress: 0 };
  let status = String(job.status || '').toLowerCase();
  if (!status && job.error) status = 'failed';
  let progress = typeof job.progress === 'number' ? job.progress : 0;
  if (progress > 0 && progress <= 1) progress = progress * 100;
  const urls = [];
  const videoUrl = job.videoUrl || job.video_url;
  const downloadUrl = job.downloadUrl || job.download_url;
  if (videoUrl) urls.push(videoUrl);
  else if (downloadUrl) urls.push(downloadUrl);
  else if (job.jobId || job.job_id) urls.push(`${MERGER_API_BASE}/api/jobs/${job.jobId || job.job_id}/video`);
  if (status === 'done' || DONE_RE.test(status)) return { status: 'completed', progress: 100, urls };
  if (FAIL_RE.test(status)) return { status: 'failed', progress, error: job.error || 'merge failed' };
  return { status: 'processing', progress: Math.min(100, Math.round(progress)) };
}

async function createMergeJob(urls) {
  const r = await mFetch('/api/jobs', { method: 'POST', json: { videos: urls } });
  if (!r || !r.jobId) throw new MergerError(200, 'unexpected merger response (missing jobId)');
  return r; // {jobId, status, statusUrl, processUrl, expiresAt}
}

// تنفيذ الدمج (blocking ~10–15 ثانية) — يُستدعى مرة واحدة فقط لكل مهمة
async function triggerProcess(jobId) {
  try {
    const r = await mFetch(`/api/jobs/${jobId}/process`, { method: 'POST', timeoutMs: 120000 });
    return r; // نجاح: {status:"done", videoUrl, downloadUrl, size, duration, resolution, expiresAt}
  } catch (e) {
    if (e instanceof MergerError && e.status >= 400 && e.status < 600 && e.status !== 0) {
      // خطأ معلن من الخدمة = فشل حتمي فوري — لا إعادة محاولة (قاعدة 7.3.5)
      return { error: e.message, final: true };
    }
    throw e; // أخطاء شبكتنا نحن = مؤقتة
  }
}

async function getJob(jobId) {
  try {
    const r = await mFetch(`/api/jobs/${jobId}`);
    return r;
  } catch (e) {
    if (e instanceof MergerError && e.status === 404) {
      // مهمة غير موجودة: حُذفت أو انتهت صلاحيتها بعد 24 ساعة → فشل نهائي
      return { status: 'failed', error: 'merge job not found on the merging service (deleted or expired after 24h)', notFound: true };
    }
    throw e;
  }
}

async function deleteJob(jobId) {
  try { await mFetch(`/api/jobs/${jobId}`, { method: 'DELETE' }); } catch (e) { /* تنظيف اختياري — تجاهل */ }
}

async function healthy() {
  if (!MERGER_API_BASE) return false;
  try {
    const r = await mFetch('/api/config', { timeoutMs: 4000 });
    return !!r;
  } catch (e) { return false; }
}

module.exports = { MergerError, createMergeJob, triggerProcess, getJob, normalizeJob, deleteJob, healthy };
