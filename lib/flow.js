// طبقة Google Flow Bridge — الأوامر والمهام ونبض الجسر:
// التوليد الفعلي يتم على جهاز المستخدم داخل متصفحه (جلسة Google الخاصة به وكريدتات
// اشتراكه على flow.google) — الخادم هنا فقط يستقبل الأوامر من MCP ويخزنها في قائمة
// flow_commands، والجسر المحلي يسحبها بالاستطلاع الطويل ويعيد الحالة/النتائج.
// لا يوجد API رسمي من Google Flow — هذا التصميم يوظف واجهة الموقع عبر المتصفح.
const crypto = require('crypto');
const db = require('./db');
const env = require('./env');

// يُعتبر الجسر متصلًا إذا كان آخر نبض خلال هذه المدة (الجسر يستطلع كل 1-2 ثانية)
const ONLINE_WINDOW_MS = 20000;

// أنواع أدوات MCP ← أنواع أوامر الجسر (نفس الاسم بدون البادئة)
function commandTypeForTool(tool) {
  return String(tool || '').replace(/^flow_/, '') || 'probe';
}

function publicBase() {
  const b = env.FLOW_PUBLIC_BASE || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || 'merger76.vercel.app';
  return String(b).replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

// حالة الجسر: متصل/غير متصل + آخر نبض + معلومات الجهاز
async function bridgeState() {
  const st = await db.flowBridgeState();
  if (!st || !st.last_seen) return { online: false, lastSeen: null, ageSeconds: null, version: null, info: {}, reason: 'لم يتصل الجسر المحلي مطلًا بعد' };
  const last = db.parseSqliteDate(st.last_seen);
  const ageMs = Date.now() - (last ? last.getTime() : 0);
  const online = ageMs < ONLINE_WINDOW_MS;
  let info = {};
  try { info = JSON.parse(st.info_json || '{}'); } catch (e) { info = {}; }
  return { online, lastSeen: st.last_seen, ageSeconds: Math.round(ageMs / 1000), version: st.version, info };
}

// رسالة إرشادية موحدة عند عدم الاتصال — لا نرمي خطأ غامض أبدًا
function offlineError(state) {
  const seen = state.lastSeen ? `آخر ظهور: ${state.lastSeen} (قبل ${state.ageSeconds} ثانية)` : 'لم يتصل الجسر مطلًا';
  return `🔌 الجسر المحلي لـ Google Flow غير متصل (${seen}). ` +
    `شغّل flow-bridge على جهازك: ملف start-flow-bridge.bat داخل مجلد bridge في المشروع ` +
    `(المتطلبات: Node 22+ على Windows، وتوكن BRIDGE_TOKEN نفسه المضبوط في Vercel). ` +
    `جرّب flow_status بعد التشغيل للتأكد من الاتصال.`;
}

// إنشاء مهمة + أمر جديد للجسر — يرفض فورًا إذا الجسر غير متصل
async function enqueue(tool, { prompt = '', payload = {} } = {}) {
  const state = await bridgeState();
  if (!state.online) return { error: offlineError(state) };
  const jobId = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  await db.flowUpsertJob({ id: jobId, tool, prompt: String(prompt || ''), commandId });
  await db.flowInsertCommand({
    id: commandId,
    jobId,
    type: commandTypeForTool(tool),
    payloadJson: JSON.stringify({ jobId, prompt, ...payload }),
  });
  return { jobId, commandId, note: 'أُرسل الأمر إلى الجسر المحلي — تابع التقدم بـ flow_check_progress' };
}

// شكل مهمة متسق لأدوات MCP
function shapeJob(j, cmd = null) {
  if (!j) return null;
  let result = null;
  try { result = j.result_json ? JSON.parse(j.result_json) : null; } catch (e) { result = null; }
  return {
    job_id: j.id,
    tool: j.tool,
    prompt: j.prompt,
    status: j.status, // queued | running | completed | failed
    progress: j.progress || 0,
    stage: j.stage || '',
    error: j.error || null,
    result,
    command_id: j.command_id,
    command_status: cmd ? cmd.status : undefined,
    created_at: j.created_at,
    updated_at: j.updated_at,
  };
}

// تقرير الحالة الكامل لأداة flow_status
async function status() {
  const state = await bridgeState();
  const counters = await db.flowCounters();
  const recent = await db.flowRecentJobs(5);
  const out = {
    bridge: {
      online: state.online,
      lastSeen: state.lastSeen,
      ageSeconds: state.ageSeconds,
      version: state.version,
      machine: state.info && state.info.machine ? state.info.machine : null,
      flowPage: state.info && state.info.flowPage ? state.info.flowPage : null,
      fake: !!(state.info && state.info.fake),
    },
    queue: counters,
    recentJobs: recent.map((j) => ({ job_id: j.id, tool: j.tool, status: j.status, progress: j.progress, stage: j.stage, updated_at: j.updated_at })),
  };
  if (!state.online) out.hint = 'لتشغيل Google Flow: ثبّت الجسر المحلي على جهازك (مجلد bridge — الملف install-windows.bat) ثم استخدم flow_probe للتحقق.';
  return out;
}

// متابعة تقدم مهمة
async function progress(jobId) {
  const job = await db.flowGetJob(String(jobId || ''));
  if (!job) return { error: `لا توجد مهمة Google Flow بالمعرّف ${jobId}` };
  const cmd = job.command_id ? await db.flowGetCommand(job.command_id) : null;
  return shapeJob(job, cmd);
}

// رابط التنزيل: وسيط عام يبث الملف من الجسر المحلي عند الطلب
async function downloadResult(jobId) {
  const job = await db.flowGetJob(String(jobId || ''));
  if (!job) return { error: `لا توجد مهمة Google Flow بالمعرّف ${jobId}` };
  if (job.status !== 'completed') return { error: `المهمة ليست مكتملة بعد (الحالة: ${job.status}، ${job.progress}%) — تابعها بـ flow_check_progress أولًا.` };
  let result = null;
  try { result = job.result_json ? JSON.parse(job.result_json) : null; } catch (e) {}
  const file = result && result.file ? result.file : null;
  if (!file) {
    // نتيجة بدون ملف (مثل معلومات الحساب) — أعد النتيجة كما هي
    return { job_id: job.id, result };
  }
  const url = `https://${publicBase()}/api/flow/file/${job.id}`;
  return {
    job_id: job.id,
    url, // رابط عام يعمل مع المتصفح وChatGPT وخدمة الدمج — يبث الملف من جهازك عبر الوسيط
    localPath: file.localPath || null, // النسخة المحفوظة على جهازك داخل مجلد bridge/results
    fileName: file.name || null,
    mimeType: file.mime || null,
    sizeBytes: file.size || null,
    note: 'الرابط يعمل أثناء تشغيل الجسر المحلي فقط — الملف محفوظ أيضًا محليًا في مجلد results.',
  };
}

// فحص سريع لجاهزية الأدوات (يستخدمه health)
async function healthSummary() {
  try {
    const state = await bridgeState();
    return { online: state.online, lastSeen: state.lastSeen };
  } catch (e) { return { online: false, lastSeen: null, error: 'flow tables unavailable' }; }
}

module.exports = {
  ONLINE_WINDOW_MS, commandTypeForTool, publicBase,
  bridgeState, offlineError, enqueue, shapeJob, status, progress, downloadResult, healthSummary,
};
