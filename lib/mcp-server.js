// خادم MCP على /mcp — نقل Streamable HTTP (وضع عديم الحالة stateless):
// POST رسائل JSON-RPC، GET يُرفض (405) لأنه لا يوجد بث دائم، DELETE ينهي الجلسة.
// يدعم بث notifications/progress عبر SSE أثناء نافذة الانتظار عندما يزود العميل
// الطلب بـ _meta.progressToken ويقبل text/event-stream.
//
// ملاحظة معمارية: ننفّد المجموعة الجزئية المطلوبة من JSON-RPC يدويًا (بدون SDK)
// لأن المشروع بلا خطوة بناء وبلا اعتماديات — الوضع العديم الحالة أكثر موثوقية
// في بيئة serverless حيث تُقتل الجلسات بين الاستدعاءات.
const crypto = require('crypto');
const env = require('./env');
const generate = require('./generate');
const db = require('./db');
const models = require('./models');
const flow = require('./flow');

const SERVER_INFO = { name: 'media-generator-mcp', version: '1.5.0' };
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
// حد انتظار فعلي 50 ثانية لملاءمة مهلة دوال Vercel (60 ثانية على الخطة المجانية) —
// بعد ذلك يُعاد task_id ويتابع العميل بـ get_task ولا يتوقف شيء.
const EFFECTIVE_WAIT_CAP = 50;

const SERVER_INSTRUCTIONS = `AI media generation server (deAPI.ai + Google Flow video, with automatic sequential multi-key failover per provider, plus optional video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
Google Omni 1.2 Flash (slug GeminiOmni12Flash, Google Flow) makes 3–15s clips with native audio, aspect 16:9 or 9:16 only — its result URL is served through the app's own media proxy.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.
Google Flow tools (flow_*): they operate the flow.google WEBSITE through a small bridge app running on the user's own Windows machine, inside the user's own signed-in browser session — generation consumes the user's Google Flow subscription credits, not any API. If flow_status shows the bridge offline, tell the user to start it (start-flow-bridge.bat in the project's bridge folder) instead of falling back to another provider.`;

const IMAGE_SLUGS = models.byType('image').map((m) => m.slug);
const VIDEO_SLUGS = models.byType('video').map((m) => m.slug);

function toolDefinitions() {
  return [
    {
      name: 'generate_image',
      description: 'Generate an image on deAPI.ai (default Z-Image Turbo INT8; also FLUX.1 Schnell, FLUX.2 Klein, Z-Anime). Automatic sequential failover across all active keys. Returns the finished image URL if it completes within the wait window, otherwise returns a task_id — call get_task every ~10 seconds until completed then show the URL and stop.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', minLength: 1, description: 'What to draw. Detailed prompts give better results.' },
          model: { type: 'string', enum: IMAGE_SLUGS, description: `Image model slug. Default: ${IMAGE_SLUGS[0]}.` },
          aspect_ratio: { type: 'string', enum: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4'], default: 'auto', description: 'Convenience size preset (ignored when width/height given).' },
          width: { type: 'integer', minimum: 128, maximum: 2048, description: 'Exact output width in pixels (multiple of the model step).' },
          height: { type: 'integer', minimum: 128, maximum: 2048, description: 'Exact output height in pixels.' },
          steps: { type: 'integer', minimum: 1, maximum: 50, description: 'Sampling steps (model-dependent; omit for the default).' },
          negative_prompt: { type: 'string', description: 'What to avoid (supported by Z-Image / FLUX.1 / Z-Anime).' },
          seed: { type: 'integer', description: 'Seed for reproducibility (-1 = random).' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: 240, default: 45, description: 'How long to stream progress before returning task_id.' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'generate_video',
      description: 'Generate a video with synchronized native audio — default model LTX-2.5 22B Distilled INT8 (text-to-video; pass image_url for image-to-video with the image as the first frame). Also available: Google Omni 1.2 Flash (Google Flow, slug GeminiOmni12Flash) — 3–15 seconds, aspect 16:9 or 9:16 only, no width/height control. Video takes minutes: short wait with streamed progress, then a task_id — track with get_task every ~10 seconds.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', maxLength: 4096, description: 'Scene description. Dialogue in the prompt is spoken in the video.' },
          model: { type: 'string', enum: VIDEO_SLUGS, description: `Video model slug. Default: Ltx2_5_22B_Dist_INT8 (deAPI) — GeminiOmni12Flash runs on Google Flow.` },
          image_url: { type: 'string', description: 'Optional public image URL used as the first frame (image-to-video).' },
          aspect_ratio: { type: 'string', enum: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4'], default: 'auto' },
          width: { type: 'integer', minimum: 512, maximum: 1344, description: 'Exact width (multiple of the model step).' },
          height: { type: 'integer', minimum: 512, maximum: 1344, description: 'Exact height.' },
          duration: { type: 'integer', minimum: 2, maximum: 15, default: 5, description: 'Duration in seconds (converted to frames at the model fps; Google Omni accepts 3–15).' },
          frames: { type: 'integer', minimum: 49, maximum: 241, description: 'Exact frame count — overrides duration.' },
          seed: { type: 'integer', description: 'Seed for reproducibility (-1 = random).' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: 240, default: 25, description: 'How long to stream progress before returning task_id.' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'merge_videos',
      description: 'Concatenate multiple clips into ONE final video in the given order. Pass \'urls\' (public direct links) or \'task_ids\' (completed video generation tasks — their result URLs are merged in this order). the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.',
      inputSchema: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 10, description: 'Public direct video URLs (http/https) in merge order — the first clip starts the final video.' },
          task_ids: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 10, description: 'Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order.' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: 240, default: 45 },
        },
      },
    },
    {
      name: 'get_task',
      description: 'Track any task by its task_id — image/video generation AND merging (reads the database and refreshes live from the provider/merging service while still running). Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.',
      inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    },
    {
      name: 'list_media',
      description: 'Latest images/videos/merges stored in the database with their links (no regeneration) — use it to recall previous results.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['image', 'video', 'merge'] },
          status: { type: 'string', enum: ['completed', 'failed', 'processing'] },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
      },
    },
    {
      // إلزامية لموصلات Deep Research في ChatGPT
      name: 'search',
      description: 'Search the media library by keyword (matches task_id, type, model, prompt or status). Returns a JSON array of {id, title, url}.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword to search for (empty = latest items).' },
        },
        required: ['query'],
      },
    },
    {
      // إلزامية لموصلات Deep Research في ChatGPT
      name: 'fetch',
      description: 'Fetch one media task by id and return its full record as JSON {id, title, text, url} — live status refresh included.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The task_id returned by search or a generation call.' },
        },
        required: ['id'],
      },
    },
    // ---------- Google Flow عبر الجسر المحلي (متصفح المستخدم وكريدتات اشتراكه) ----------
    {
      name: 'flow_status',
      description: 'Google Flow bridge status: is the local bridge app running on the user\'s machine, its version, machine info, queue depth and the latest flow jobs. Call this FIRST before any flow_* generation tool — if offline, tell the user to start it; never fall back to other providers silently.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'flow_generate_video',
      description: 'Generate a video on the flow.google WEBSITE via the user\'s local browser bridge — uses the user\'s Google Flow subscription credits (Veo 3.1 / Omni Flash etc., exactly the models their account shows). Requires the bridge online (check flow_status first). Returns job_id immediately — then poll flow_check_progress until completed, then flow_download_result for the file.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', maxLength: 4000, description: 'Scene description (dialogue in the prompt is spoken in the video).' },
          model: { type: 'string', description: 'Optional Flow UI model name as shown in the account probe, e.g. "Veo 3.1 - Fast", "Omni Flash". Omit to keep whatever is selected in the UI.' },
          aspect_ratio: { type: 'string', enum: ['16:9', '9:16'], description: 'Optional — Flow video supports 16:9 and 9:16. Omit to keep the UI selection.' },
          count: { type: 'integer', minimum: 1, maximum: 4, description: 'Optional number of outputs (1-4) if the UI shows the count control.' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'flow_generate_image',
      description: 'Generate an image on the flow.google WEBSITE via the user\'s local browser bridge (Nano Banana models etc. as the account shows) — uses the user\'s Google Flow subscription credits. Requires the bridge online. Returns job_id — poll flow_check_progress, then flow_download_result.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', maxLength: 4000, description: 'What to draw.' },
          model: { type: 'string', description: 'Optional Flow UI image model name, e.g. "Nano Banana Pro". Omit to keep the UI selection.' },
          aspect_ratio: { type: 'string', enum: ['16:9', '4:3', '1:1', '3:4', '9:16'], description: 'Optional. Omit to keep the UI selection.' },
          count: { type: 'integer', minimum: 1, maximum: 4, description: 'Optional number of outputs.' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'flow_upload_reference',
      description: 'Upload a reference image into the current Google Flow project via the local bridge (downloads the image from a public URL on the user\'s machine and inserts it as an ingredient/reference for the next generation). Requires the bridge online.',
      inputSchema: {
        type: 'object',
        properties: {
          image_url: { type: 'string', description: 'Public URL of the image to upload as reference.' },
        },
        required: ['image_url'],
      },
    },
    {
      name: 'flow_check_progress',
      description: 'Check the live status of a Google Flow bridge job (queued/running/completed/failed with progress %, stage text and the result when done). Poll every ~10 seconds.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'The job_id returned by flow_generate_video / flow_generate_image.' },
        },
        required: ['job_id'],
      },
    },
    {
      name: 'flow_download_result',
      description: 'Get the finished Google Flow result for a completed job: a public streaming URL (served through this server from the user\'s machine) plus the local file path. Use the URL to show/download the file; it works while the bridge is running.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
        },
        required: ['job_id'],
      },
    },
  ];
}

// ---------- صياغة الردود العربية (§8) ----------
function urlsOf(task) {
  try { return JSON.parse(task.result_urls_json || '[]'); } catch (e) { return []; }
}

function formatCompleted(task) {
  const urls = urlsOf(task);
  if (task.type === 'image') {
    const u = urls[0] || '';
    return `✅ تم توليد الصورة بنجاح\n\n![image](${u})\n\nالرابط المباشر: ${u}\n\n(رابط المزود صالح حوالي 5 ساعات — حمّل الصورة أو استخدم الرابط فورًا)`;
  }
  if (task.type === 'merge') {
    const list = urls.map((u, i) => `${i + 1}. ${u}`).join('\n');
    return `✅ تم دمج المقاطع بنجاح\n\nالروابط المباشرة:\n${list}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
  }
  const list = urls.map((u, i) => `${urls.length > 1 ? i + 1 + '. ' : ''}${u}`).join('\n');
  return `✅ تم توليد الفيديو بنجاح\n\nالرابط المباشر: ${list}\n\n(رابط المزود صالح حوالي 5 ساعات — حمّل الفيديو أو استخدم الرابط فورًا)`;
}

function formatProcessing(task) {
  const pct = task.progress ? ` (${task.progress}%)` : '';
  return `⏳ المهمة قيد المعالجة${pct} — task_id: ${task.id}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

function formatFailed(task) {
  return `❌ فشلت المهمة: ${task.error_message || 'سبب غير معروف'}`;
}

function taskToToolText(task) {
  if (!task) return { text: '❌ المهمة غير موجودة في قاعدة البيانات.', isError: true };
  if (task.status === 'completed') return { text: formatCompleted(task) };
  if (task.status === 'failed') return { text: formatFailed(task), isError: true };
  return { text: formatProcessing(task) };
}

// ---------- تنفيذ الأدوات ----------
async function callTool(name, args = {}, { onProgress } = {}) {
  switch (name) {
    case 'generate_image':
    case 'generate_video': {
      const type = name === 'generate_image' ? 'image' : 'video';
      const { prompt, model, aspect_ratio, width, height, steps, negative_prompt, seed, image_url, duration, frames, wait_seconds } = args;
      const params = {};
      if (prompt !== undefined) params.prompt = prompt;
      if (model !== undefined) params.model = model;
      if (aspect_ratio !== undefined) params.aspect_ratio = aspect_ratio;
      if (width !== undefined) params.width = width;
      if (height !== undefined) params.height = height;
      if (steps !== undefined) params.steps = steps;
      if (negative_prompt !== undefined) params.negative_prompt = negative_prompt;
      if (seed !== undefined) params.seed = seed;
      if (image_url !== undefined) params.image_url = image_url;
      if (duration !== undefined) params.duration = duration;
      if (frames !== undefined) params.frames = frames;
      const wait = Math.min(EFFECTIVE_WAIT_CAP, wait_seconds === undefined ? (type === 'image' ? 45 : 25) : Number(wait_seconds) || 0);
      const task = await generate.runGeneration({ type, modelName: params.model, params, waitSeconds: wait, onProgress });
      return taskToToolText(task);
    }
    case 'merge_videos': {
      const wait = Math.min(EFFECTIVE_WAIT_CAP, args.wait_seconds === undefined ? 45 : Number(args.wait_seconds) || 0);
      const task = await generate.runMerge({ urls: args.urls, taskIds: args.task_ids, waitSeconds: wait, onProgress });
      return taskToToolText(task);
    }
    case 'get_task': {
      const task = await generate.refreshTask(String(args.task_id || ''));
      if (!task) return { text: `❌ لا توجد مهمة بالمعرّف ${args.task_id}.`, isError: true };
      return taskToToolText(task);
    }
    case 'list_media': {
      const rows = await db.listRecentTasks(args.limit || 10, { type: args.type, status: args.status });
      if (!rows.length) return { text: 'لا توجد وسائط مخزنة بعد. ولّد صورة أو فيديو أولًا بـ generate_image أو generate_video.' };
      const emoji = { image: '🖼️', video: '🎬', merge: '🔗' };
      const statusAr = { completed: 'مكتملة', failed: 'فاشلة', processing: 'جارية', pending: 'بانتظار' };
      const lines = rows.map((t, i) => {
        const u = urlsOf(t);
        const link = t.status === 'completed' && u.length ? ` — الرابط: ${u[0]}` : '';
        const err = t.status === 'failed' && t.error_message ? ` — السبب: ${t.error_message}` : '';
        return `${i + 1}. ${emoji[t.type] || '•'} [${statusAr[t.status] || t.status}] ${t.type} — ${t.model} — task_id: ${t.id}${link}${err}`;
      });
      return { text: 'أحدث الوسائط المخزنة:\n\n' + lines.join('\n') };
    }
    case 'search': {
      // تنسيق موصلات Deep Research: مصفوفة JSON من {id, title, url}
      const q = String(args.query || '').trim().toLowerCase();
      const rows = await db.listRecentTasks(50);
      const filtered = q
        ? rows.filter((t) => [t.id, t.type, t.model, t.prompt, t.status].filter(Boolean).join(' ').toLowerCase().includes(q))
        : rows;
      const results = filtered.slice(0, 20).map((t) => {
        const u = urlsOf(t);
        return {
          id: t.id,
          title: `${t.type} — ${t.model} — ${t.status}`,
          url: t.status === 'completed' && u[0] ? u[0] : '',
        };
      });
      return { text: JSON.stringify(results, null, 2) };
    }
    case 'fetch': {
      // تنسيق موصلات Deep Research: كائن JSON من {id, title, text, url} مع تحديث حي للحالة
      const task = await generate.refreshTask(String(args.id || ''));
      if (!task) return { text: `❌ لا توجد مهمة بالمعرّف ${args.id}.`, isError: true };
      const u = urlsOf(task);
      const lines = [`نوع: ${task.type}`, `الموديل: ${task.model}`, `الحالة: ${task.status}`];
      if (task.prompt) lines.push(`الطلب: ${task.prompt}`);
      if (task.error_message) lines.push(`الخطأ: ${task.error_message}`);
      if (task.status === 'completed' && u.length) {
        lines.push('', 'الروابط:');
        u.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
        if (task.type === 'image') lines.push('', `![image](${u[0]})`);
      }
      return {
        text: JSON.stringify({
          id: task.id,
          title: `${task.type} — ${task.model}`,
          text: lines.join('\n'),
          url: task.status === 'completed' && u[0] ? u[0] : '',
        }, null, 2),
      };
    }
    // ---------- Google Flow عبر الجسر المحلي ----------
    case 'flow_status': {
      const s = await flow.status();
      const b = s.bridge;
      const lines = [
        b.online
          ? `🟢 الجسر المحلي متصل — آخر نبض قبل ${b.ageSeconds} ثانية${b.version ? ` · الإصدار ${b.version}` : ''}${b.fake ? ' · وضع محاكاة (FAKE) — لا يلمس Flow الفعلي' : ''}`
          : `🔴 الجسر المحلي غير متصل${b.lastSeen ? ` — آخر ظهور: ${b.lastSeen}` : ' — لم يتصل مطلًا'}`,
        '',
        `طابور الأوامر المعلقة: ${s.queue.pendingCommands} · مهام جارية: ${s.queue.activeJobs}`,
      ];
      if (b.machine) lines.push(`الجهاز: ${b.machine}`);
      if (b.flowPage) lines.push(`صفحة Flow الحالية: ${b.flowPage}`);
      if (s.recentJobs.length) {
        lines.push('', 'أحدث مهام Google Flow:');
        s.recentJobs.forEach((j, i) => lines.push(`${i + 1}. [${j.status}] ${j.tool} — ${j.progress}% — job_id: ${j.job_id}${j.stage ? ` — ${j.stage}` : ''}`));
      }
      if (s.hint) lines.push('', '💡 ' + s.hint);
      return { text: lines.join('\n') };
    }
    case 'flow_generate_video':
    case 'flow_generate_image': {
      const tool = name;
      if (!String(args.prompt || '').trim()) return { text: '❌ الوصف (prompt) مطلوب.', isError: true };
      const payload = {};
      if (args.model !== undefined) payload.model = args.model;
      if (args.aspect_ratio !== undefined) payload.aspect_ratio = args.aspect_ratio;
      if (args.count !== undefined) payload.count = args.count;
      const r = await flow.enqueue(tool, { prompt: String(args.prompt), payload });
      if (r.error) return { text: '❌ ' + r.error, isError: true };
      return { text: `🎬 أُرسل أمر ${tool === 'flow_generate_video' ? 'توليد الفيديو' : 'توليد الصورة'} إلى Google Flow عبر جهاز المستخدم.\n\njob_id: ${r.jobId}\n\nالكريدتات ستُستهلك من اشتراك Google Flow لديه عبر واجهة الموقع في متصفحه. تابع بـ flow_check_progress كل ~10 ثوانٍ حتى تكتمل، ثم جلب الملف بـ flow_download_result.` };
    }
    case 'flow_upload_reference': {
      const u = String(args.image_url || '').trim();
      if (!/^https?:\/\//i.test(u)) return { text: '❌ رابط صورة عام (image_url) مطلوب.', isError: true };
      const r = await flow.enqueue('flow_upload_reference', { payload: { image_url: u } });
      if (r.error) return { text: '❌ ' + r.error, isError: true };
      return { text: `📎 أُرسل أمر رفع الصورة المرجعية إلى الجسر المحلي.\n\njob_id: ${r.jobId}\n\nتابع بـ flow_check_progress.` };
    }
    case 'flow_check_progress': {
      const p = await flow.progress(String(args.job_id || ''));
      if (p.error) return { text: '❌ ' + p.error, isError: true };
      if (p.status === 'completed') {
        let out = `✅ مهمة Google Flow اكتملت\n\njob_id: ${p.job_id}\nالأداة: ${p.tool}`;
        if (p.result && p.result.summary) out += `\nالنتيجة: ${p.result.summary}`;
        if (p.result && p.result.file && p.result.file.name) out += `\nالملف: ${p.result.file.name} (${Math.round((p.result.file.size || 0) / 1024)} KB)`;
        out += `\n\nاجلب رابط التنزيل بـ flow_download_result.`;
        return { text: out };
      }
      if (p.status === 'failed') return { text: `❌ فشلت مهمة Google Flow: ${p.error || p.stage || 'سبب غير معروف'}\n\njob_id: ${p.job_id}`, isError: true };
      return { text: `⏳ مهمة Google Flow قيد التنفيذ (${p.progress}%) — المرحلة: ${p.stage || '…'}\n\njob_id: ${p.job_id}\n\nأعد الاستدعاء كل ~10 ثوانٍ.` };
    }
    case 'flow_download_result': {
      const d = await flow.downloadResult(String(args.job_id || ''));
      if (d.error) return { text: '❌ ' + d.error, isError: true };
      if (!d.url) return { text: `نتيجة المهمة ${d.job_id}:\n\n${JSON.stringify(d.result, null, 2)}` };
      let out = `✅ ملف Google Flow جاهز\n\nالرابط العام (يبث من جهاز المستخدم عبر الوسيط):\n${d.url}`;
      if (d.localPath) out += `\n\nالنسخة المحلية على جهازه: ${d.localPath}`;
      if (d.fileName) out += `\nالملف: ${d.fileName} (${Math.round((d.sizeBytes || 0) / 1024)} KB)`;
      out += `\n\n⚠️ الرابط يعمل أثناء تشغيل الجسر المحلي — النسخة المحلية دائمة في مجلد results.`;
      return { text: out };
    }
    default:
      return { text: `❌ أداة غير معروفة: ${name}. المتاح: generate_image، generate_video، merge_videos، get_task، list_media، search، fetch، flow_status، flow_generate_video، flow_generate_image، flow_upload_reference، flow_check_progress، flow_download_result`, isError: true };
  }
}

// ---------- معالجة JSON-RPC ----------
function sseWrite(res, obj) {
  res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
}

async function handleRpc(msg, { res, sse, progressToken }) {
  const { method, id, params = {} } = msg || {};

  // إشعارات بلا معرّف → لا رد لها (مثل notifications/initialized)
  if (id === undefined || id === null) return null;

  if (method === 'initialize') {
    const requested = params.protocolVersion;
    const version = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1];
    return {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: SERVER_INSTRUCTIONS,
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: toolDefinitions() };
  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    // بث التقدم: كل ~3 ثوانٍ عبر SSE عندما زوّد العميل progressToken
    const onProgress = (sse && progressToken !== undefined)
      ? (progress, message) => {
          try {
            sseWrite(res, {
              jsonrpc: '2.0', method: 'notifications/progress',
              params: { progressToken, progress, total: 100, message: String(message || '') },
            });
          } catch (e) { /* العميل غادر — نستمر داخليًا */ }
        }
      : undefined;
    try {
      const out = await callTool(name, args, { onProgress, sse, progressToken });
      const content = [{ type: 'text', text: out.text }];
      return { content, isError: !!out.isError };
    } catch (e) {
      if (e.code === 'no_keys' || e.code === 'merger_unconfigured') {
        return { content: [{ type: 'text', text: e.message }] };
      }
      if (e.code === 'params') {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
      return { content: [{ type: 'text', text: `❌ خطأ داخلي غير متوقع: ${generate.sanitizeError(e.message)}` }], isError: true };
    }
  }
  return { error: { code: -32601, message: `Method not found: ${method}` } };
}

async function handleMcp(req, res) {
  const { cors, readBody } = require('./http');
  cors(res);

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method === 'DELETE') { res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); return res.end('{}'); }
  if (req.method === 'GET') {
    // وضع عديم الحالة: لا بث SSE دائم للخادم→العميل
    res.statusCode = 405;
    res.setHeader('Allow', 'POST, DELETE, OPTIONS');
    return jsonErr(res, -32200, 'GET is not supported in stateless mode — send JSON-RPC over POST /mcp');
  }

  // حماية اختيارية بمفتاح Bearer
  if (env.MCP_ACCESS_TOKEN) {
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (got !== env.MCP_ACCESS_TOKEN) {
      res.statusCode = 401;
      return jsonErr(res, -32001, 'unauthorized: missing or invalid MCP_ACCESS_TOKEN');
    }
  }

  let raw;
  try { raw = await readBody(req, 2); } catch (e) {
    res.statusCode = 400;
    return jsonErr(res, -32700, 'Parse error');
  }
  let msgs;
  try { msgs = JSON.parse(raw || '{}'); } catch (e) {
    res.statusCode = 400;
    return jsonErr(res, -32700, 'Parse error: invalid JSON');
  }
  const isBatch = Array.isArray(msgs);
  const list = isBatch ? msgs : [msgs];

  // هل يطلب العميل بثًا عبر SSE؟
  const accept = String(req.headers.accept || '');
  const wantsSse = accept.includes('text/event-stream');
  const progressToken = list.length === 1 && list[0] && list[0].params && list[0].params._meta && list[0].params._meta.progressToken;

  // الجلسة: نولّد معرّفًا ونصدقه عند وروده — عديم الحالة داخليًا
  const incoming = req.headers['mcp-session-id'];
  const sessionId = typeof incoming === 'string' && incoming ? incoming : crypto.randomUUID();
  res.setHeader('Mcp-Session-Id', sessionId);

  const responses = [];

  // وضع SSE لأدوات tools/call: ترويسات البث تُضبط قبل أي كتابة (وإلا فشل setHeader بعد الإرسال)
  const isSseCall = wantsSse && !isBatch && list[0] && list[0].method === 'tools/call';
  let sseStarted = false;
  if (isSseCall) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();
    sseStarted = true;
  }

  for (const m of list) {
    if (m && m.method === 'notifications/initialized' && m.id === undefined) continue; // إشعار → لا رد
    const out = await handleRpc(m, { res, sse: sseStarted, progressToken });
    if (out) responses.push({ jsonrpc: '2.0', id: m.id, ...(out.error ? { error: out.error } : { result: out }) });
  }

  if (!responses.length) {
    if (!sseStarted) res.statusCode = 202;
    return res.end();
  }

  if (sseStarted) {
    // بث SSE: الرد النهائي كرسالة واحدة ثم الإغلاق
    sseWrite(res, isBatch ? responses : responses[0]);
    return res.end();
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(isBatch ? responses : responses[0]));
}

function jsonErr(res, code, message) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

module.exports = { handleMcp, SERVER_INFO, SERVER_INSTRUCTIONS, toolDefinitions };
