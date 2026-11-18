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
const deapi = require('./deapi');
const keysLib = require('./keys');

const SERVER_INFO = { name: 'media-generator-mcp', version: '1.6.0' };
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
// حد انتظار فعلي 50 ثانية لملاءمة مهلة دوال Vercel (60 ثانية على الخطة المجانية) —
// بعد ذلك يُعاد task_id ويتابع العميل بـ get_task ولا يتوقف شيء.
const EFFECTIVE_WAIT_CAP = 50;

const SERVER_INSTRUCTIONS = `AI media generation server (deAPI.ai with automatic sequential multi-key failover, plus optional video merging).
Capabilities: generate_image (text→image), edit_image (image+text→image), generate_video (text→video, or image→video passing image_url as the first frame), text_to_speech (text→mp3), merge_videos (concatenate clips), list_models (ALL available model slugs, voices and prices), check_balance (remaining credits), get_task (track), list_media (recall previous results).
Workflow: if unsure which model slug or voice to use, call list_models FIRST. Then call the generation tool. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
Every completed task reports its actual cost (💰 التكلفة). check_balance shows the remaining deAPI balance per key (keys without Admin permission cannot report it).
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Provider result links expire after ~5 hours — always tell the user to download/watch promptly.
Use list_media to recall previously generated media from the database.`;

const IMAGE_SLUGS = models.byType('image').map((m) => m.slug);
const EDIT_SLUGS = models.byType('edit').map((m) => m.slug).concat(['Flux_2_Klein_4B_BF16']);
const VIDEO_SLUGS = models.byType('video').map((m) => m.slug);
const SPEECH_SLUGS = models.byType('speech').map((m) => m.slug);

function toolDefinitions() {
  return [
    {
      name: 'generate_image',
      description: 'Generate an image from a text prompt (text→image) on deAPI.ai — default Z-Image Turbo INT8; static alternatives: FLUX.1 Schnell, FLUX.2 Klein, Z-Anime. Call list_models for ALL current slugs. Automatic sequential failover across all active keys. Returns the finished image URL if it completes within the wait window, otherwise returns a task_id — call get_task every ~10 seconds until completed then show the URL and stop.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', minLength: 1, description: 'What to draw. Detailed prompts give better results.' },
          model: { type: 'string', description: `Image model slug — default: ${IMAGE_SLUGS[0]}. Full list via list_models (type=image).` },
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
      name: 'edit_image',
      description: 'Edit an existing image with a text instruction (image+text→image) on deAPI.ai — default Qwen Image Edit Plus NF4 (multi-image composition supported), also FLUX.2 Klein 4B. Pass image_url (public link, ≤10MB) or up to 5 image_urls. Automatic multi-key failover. Returns the finished image URL within the wait window, otherwise a task_id — poll get_task every ~10 seconds.',
      inputSchema: {
        type: 'object',
        properties: {
          image_url: { type: 'string', description: 'Public URL of the image to edit (max 10MB).' },
          image_urls: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Alternative to image_url: up to 5 public image URLs for multi-image composition/merge (Qwen Image Edit).' },
          prompt: { type: 'string', minLength: 1, description: 'The edit instruction — what to change, add or remove.' },
          model: { type: 'string', description: `Edit model slug — default: ${EDIT_SLUGS[0]}. Full list via list_models (type=edit).` },
          negative_prompt: { type: 'string', description: 'What to avoid (if the model supports it).' },
          steps: { type: 'integer', minimum: 1, maximum: 50, description: 'Sampling steps when the model supports them (Flux.2 Klein: fixed 4).' },
          guidance: { type: 'number', description: 'Guidance scale when the model supports it.' },
          width: { type: 'integer', minimum: 128, maximum: 2048, description: 'Optional output width (else the input size is kept).' },
          height: { type: 'integer', minimum: 128, maximum: 2048, description: 'Optional output height.' },
          seed: { type: 'integer', description: 'Seed for reproducibility (-1 = random).' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: 240, default: 45, description: 'How long to stream progress before returning task_id.' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'generate_video',
      description: 'Generate a video with synchronized native audio on deAPI.ai — default LTX-2.5 22B Distilled INT8. Two modes: text→video (prompt only) and image→video (pass image_url — the public image becomes the animated first frame). Call list_models for ALL video slugs (also MiniMax H3, LTX-2.3, LTX-Video 13B, seedance). Video takes minutes: short wait with streamed progress, then a task_id — track with get_task every ~10 seconds.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', maxLength: 4096, description: 'Scene description. Dialogue in the prompt is spoken in the video.' },
          model: { type: 'string', description: `Video model slug — default: ${VIDEO_SLUGS[0]}. Full list via list_models (type=video).` },
          image_url: { type: 'string', description: 'Optional public image URL used as the first frame (image-to-video mode, 1KB–10MB).' },
          aspect_ratio: { type: 'string', enum: ['auto', '1:1', '16:9', '9:16', '4:3', '3:4'], default: 'auto' },
          width: { type: 'integer', minimum: 512, maximum: 1344, description: 'Exact width (multiple of the model step).' },
          height: { type: 'integer', minimum: 512, maximum: 1344, description: 'Exact height.' },
          duration: { type: 'integer', minimum: 2, maximum: 10, default: 5, description: 'Duration in seconds (converted to frames at the model fps).' },
          frames: { type: 'integer', minimum: 49, maximum: 241, description: 'Exact frame count — overrides duration.' },
          seed: { type: 'integer', description: 'Seed for reproducibility (-1 = random).' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: 240, default: 25, description: 'How long to stream progress before returning task_id.' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'text_to_speech',
      description: 'Convert text into natural speech audio (mp3, text→speech) on deAPI.ai — default Kokoro (voices like af_sky, af_bella, am_adam; langs en-us, en-gb, …). Also Chatterbox and Qwen3-TTS: custom_voice, voice_clone (clone a voice from a 5–15s reference clip via ref_audio_url) and voice_design (describe the voice via instruct). Call list_models (type=speech) for exact slugs, languages and voices. Returns the audio URL within the wait window, otherwise a task_id — poll get_task every ~10 seconds.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, description: 'The text to speak (language must match the chosen lang).' },
          model: { type: 'string', description: `TTS model slug — default: ${SPEECH_SLUGS[0]}. Full list via list_models (type=speech).` },
          lang: { type: 'string', description: 'Language code from the model catalog (e.g. en-us, en-gb). Default per model (Kokoro: en-us).' },
          voice: { type: 'string', description: 'Voice id in custom_voice mode (Kokoro e.g. af_sky, af_bella, af_nova, am_adam, am_michael, bf_emma, bm_george). Omit for the model default.' },
          speed: { type: 'number', minimum: 0.5, maximum: 2, description: 'Speaking speed. Default 1.' },
          mode: { type: 'string', enum: ['custom_voice', 'voice_clone', 'voice_design'], description: 'Qwen3-TTS modes: custom_voice (default), voice_clone (requires ref_audio_url), voice_design (requires instruct).' },
          ref_audio_url: { type: 'string', description: 'Public URL of a 5–15 second reference audio clip (max 15MB) for voice_clone mode.' },
          instruct: { type: 'string', description: 'Voice design instruction for voice_design mode (e.g. "a warm elderly narrator").' },
          format: { type: 'string', default: 'mp3', description: 'Output audio format (all current models: mp3).' },
          sample_rate: { type: 'integer', default: 24000, description: 'Audio sample rate (current models: 24000).' },
          wait_seconds: { type: 'integer', minimum: 0, maximum: 240, default: 45, description: 'How long to stream progress before returning task_id.' },
        },
        required: ['text'],
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
      name: 'list_models',
      description: 'List ALL models available for generation (live catalog from deAPI.ai, grouped by capability): image (txt2img), image editing (img2img), video (txt2video + img2video) and text-to-speech (txt2speech) — with exact model slugs, names, statuses and prices/voices/languages when the catalog provides them. Call this FIRST whenever unsure which slug to pass to generate_image / edit_image / generate_video / text_to_speech.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['all', 'image', 'edit', 'video', 'speech'], default: 'all', description: 'Filter by capability — all returns every group.' },
        },
      },
    },
    {
      name: 'check_balance',
      description: 'Show the remaining deAPI.ai account balance (the credits that generation consumes) per active API key and their total. Keys without Admin permission cannot report a balance (they still work for generation). Every completed generation task also reports its actual cost in the response.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_media',
      description: 'Latest images/edits/videos/speech/merges stored in the database with their links (no regeneration) — use it to recall previous results.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['image', 'edit', 'video', 'speech', 'merge'] },
          status: { type: 'string', enum: ['completed', 'failed', 'processing'] },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
      },
    },
  ];
}

// ---------- صياغة الردود العربية (§8) ----------
function urlsOf(task) {
  try { return JSON.parse(task.result_urls_json || '[]'); } catch (e) { return []; }
}

// التكلفة الفعلية للمهمة كما أعلنها المزود {amount, is_estimated}
function priceLine(task) {
  let p = null;
  try { p = JSON.parse(task.price_json || 'null'); } catch (e) { p = null; }
  if (!p || p.amount === undefined || p.amount === null || p.amount === '') return '';
  return `\n\n💰 التكلفة: ${p.amount}${p.is_estimated ? ' (تقديرية)' : ' فعلية'} — من رصيد deAPI (استعلم بـ check_balance)`;
}

function formatCompleted(task) {
  const urls = urlsOf(task);
  if (task.type === 'image') {
    const u = urls[0] || '';
    return `✅ تم توليد الصورة بنجاح\n\n![image](${u})\n\nالرابط المباشر: ${u}\n\n(رابط المزود صالح حوالي 5 ساعات — حمّل الصورة أو استخدم الرابط فورًا)` + priceLine(task);
  }
  if (task.type === 'edit') {
    const u = urls[0] || '';
    return `✅ تم تحرير الصورة بنجاح (صورة+نص→صورة)\n\n![image](${u})\n\nالرابط المباشر: ${u}\n\n(رابط المزود صالح حوالي 5 ساعات — حمّل الصورة أو استخدم الرابط فورًا)` + priceLine(task);
  }
  if (task.type === 'speech') {
    const u = urls[0] || '';
    return `🔊 تم تحويل النص إلى كلام بنجاح\n\nالرابط المباشر للصوت: ${u}\n\n(mp3 من المزود — صالح حوالي 5 ساعات، حمّله فورًا)` + priceLine(task);
  }
  if (task.type === 'merge') {
    const list = urls.map((u, i) => `${i + 1}. ${u}`).join('\n');
    return `✅ تم دمج المقاطع بنجاح\n\nالروابط المباشرة:\n${list}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
  }
  const list = urls.map((u, i) => `${urls.length > 1 ? i + 1 + '. ' : ''}${u}`).join('\n');
  return `✅ تم توليد الفيديو بنجاح\n\nالرابط المباشر: ${list}\n\n(رابط المزود صالح حوالي 5 ساعات — حمّل الفيديو أو استخدم الرابط فورًا)` + priceLine(task);
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
    case 'edit_image':
    case 'generate_video': {
      const type = name === 'generate_image' ? 'image' : name === 'edit_image' ? 'edit' : 'video';
      const { prompt, model, aspect_ratio, width, height, steps, negative_prompt, seed, image_url, image_urls, guidance, duration, frames, wait_seconds } = args;
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
      if (image_urls !== undefined) params.image_urls = image_urls;
      if (guidance !== undefined) params.guidance = guidance;
      if (duration !== undefined) params.duration = duration;
      if (frames !== undefined) params.frames = frames;
      const wait = Math.min(EFFECTIVE_WAIT_CAP, wait_seconds === undefined ? (type === 'video' ? 25 : 45) : Number(wait_seconds) || 0);
      const task = await generate.runGeneration({ type, modelName: params.model, params, waitSeconds: wait, onProgress });
      return taskToToolText(task);
    }
    case 'text_to_speech': {
      const text = String(args.text || '').trim();
      if (!text) return { text: '❌ النص المراد تحويله إلى كلام (text) مطلوب.', isError: true };
      const params = { prompt: text, text };
      for (const k of ['model', 'lang', 'voice', 'speed', 'mode', 'instruct', 'ref_audio_url', 'format', 'sample_rate']) {
        if (args[k] !== undefined) params[k] = args[k];
      }
      const wait = Math.min(EFFECTIVE_WAIT_CAP, args.wait_seconds === undefined ? 45 : Number(args.wait_seconds) || 0);
      const task = await generate.runGeneration({ type: 'speech', modelName: params.model, params, waitSeconds: wait, onProgress });
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
      const emoji = { image: '🖼️', video: '🎬', merge: '🔗', edit: '🖌️', speech: '🔊' };
      const statusAr = { completed: 'مكتملة', failed: 'فاشلة', processing: 'جارية', pending: 'بانتظار' };
      const lines = rows.map((t, i) => {
        const u = urlsOf(t);
        const link = t.status === 'completed' && u.length ? ` — الرابط: ${u[0]}` : '';
        const err = t.status === 'failed' && t.error_message ? ` — السبب: ${t.error_message}` : '';
        return `${i + 1}. ${emoji[t.type] || '•'} [${statusAr[t.status] || t.status}] ${t.type} — ${t.model} — task_id: ${t.id}${link}${err}`;
      });
      return { text: 'أحدث الوسائط المخزنة:\n\n' + lines.join('\n') };
    }
    // ---------- النماذج والرصيد ----------
    case 'list_models': {
      const f = String(args.type || 'all');
      let items = null;
      try {
        const pool = await db.getKeyPool(['deapi']);
        if (pool.length) items = await deapi.fetchCatalog(pool[0].api_key);
      } catch (e) { items = null; }
      let source = 'الكتالوج الحي من deAPI.ai';
      if (!items || !items.length) {
        source = 'السجل الثابت المحلي (تعذر جلب الكتالوج الحي — لا مفاتيح أو خطأ مؤقت)';
        items = models.MODELS.filter((m) => m.provider !== 'google-flow').map((m) => ({
          slug: m.slug, name: m.label,
          inference_types: [m.type === 'image' ? 'txt2img' : m.type === 'edit' ? 'img2img' : m.type === 'video' ? 'txt2video' : 'txt2speech'],
        }));
      }
      const GROUPS = [
        ['image', 'txt2img', '🖼️ توليد صورة من نص'],
        ['edit', 'img2img', '🖌️ تحرير صورة (صورة+نص→صورة)'],
        ['video', 'txt2video', '🎬 فيديو من نص'],
        ['video', 'img2video', '🎬 فيديو من صورة'],
        ['speech', 'txt2speech', '🔊 تحويل النص إلى كلام'],
      ];
      const wanted = f === 'all' ? null : f;
      const lines = [`📦 النماذج المتاحة (${source}):\n`];
      let shown = 0;
      for (const [gkey, inf, title] of GROUPS) {
        if (wanted && wanted !== gkey) continue;
        const list = items.filter((c) => Array.isArray(c.inference_types) && c.inference_types.includes(inf));
        if (!list.length) continue;
        lines.push(`${title}:`);
        for (const c of list) {
          const info = c.info || {};
          const price = c.price !== undefined && c.price !== null ? c.price : info.price;
          const extra = [];
          if (price !== undefined && price !== null && price !== '') extra.push(`السعر: ${typeof price === 'object' ? JSON.stringify(price) : price}`);
          if (inf === 'txt2speech') {
            const langs = Array.isArray(info.languages) ? info.languages.map((l) => l && l.slug).filter(Boolean) : [];
            const voices = Array.isArray(info.voices) ? info.voices.map((v) => v && (v.slug || v.name || v)).filter(Boolean) : [];
            if (langs.length) extra.push(`اللغات: ${langs.slice(0, 12).join(', ')}${langs.length > 12 ? '…' : ''}`);
            if (voices.length) extra.push(`الأصوات: ${voices.slice(0, 12).join(', ')}${voices.length > 12 ? '…' : ''}`);
          }
          const st = c.status && c.status !== 'active' ? ` [${c.status}]` : '';
          lines.push(`• ${c.slug} — ${c.name || ''}${st}${extra.length ? ` (${extra.join(' · ')})` : ''}`);
          shown++;
        }
        lines.push('');
      }
      // موديلات بأنواع أخرى (مثل audio-to-text) عند الطلب الشامل — لا تخدمها أدوات هذا الخادم
      if (!wanted) {
        const known = ['txt2img', 'img2img', 'txt2video', 'img2video', 'txt2speech'];
        const others = items.filter((c) => Array.isArray(c.inference_types) && c.inference_types.length && !c.inference_types.some((t) => known.includes(t)));
        if (others.length) {
          lines.push('أنواع أخرى في الكتالوج (لا تخدمها أدوات هذا الخادم):');
          others.forEach((c) => lines.push(`• ${c.slug} — ${c.name || ''} (${(c.inference_types || []).join(', ')})`));
          lines.push('');
        }
      }
      const gf = models.MODELS.filter((m) => m.provider === 'google-flow');
      if (!wanted || wanted === 'video') {
        if (gf.length) {
          lines.push('☁️ مزود إضافي (Google Flow — يتطلب مفتاح Google Flow من واجهة الإدارة):');
          gf.forEach((m) => lines.push(`• ${m.slug} — ${m.label} (فيديو 3–15 ثانية بصوت أصلي، 16:9 أو 9:16)`));
          lines.push('');
        }
      }
      lines.push('استخدم الـ slug كما هو في خاصية model لأدوات التوليد — والأسماء البديلة (aliases) مقبولة أيضًا.');
      if (!shown && wanted) lines.push('(لا توجد نماذج من هذا النوع في الكتالوج الحي حاليًا)');
      return { text: lines.join('\n') };
    }
    case 'check_balance': {
      const pool = await db.getKeyPool(['deapi']);
      if (!pool.length) {
        return { text: '❌ لا توجد مفاتيح deAPI نشطة — أضف مفتاحًا من واجهة الإدارة (لوحة الويب) ثم أعد المحاولة.', isError: true };
      }
      const lines = ['💰 رصيد حسابات deAPI — الرصيد الذي يُستهلك عند كل توليد:\n'];
      let total = 0, okCount = 0;
      for (const k of pool) {
        try {
          const b = await deapi.fetchBalance(k.api_key);
          total += b; okCount++;
          lines.push(`• ${keysLib.maskKey(k.api_key)}${k.label ? ` (${k.label})` : ''}: ${b}`);
        } catch (e) {
          const noAdmin = e.status === 403 || /permission|admin/i.test(String(e.message));
          lines.push(`• ${keysLib.maskKey(k.api_key)}${k.label ? ` (${k.label})` : ''}: ${noAdmin ? 'بدون صلاحية Admin — المفتاح يعمل للتوليد فقط ولا يمكن قراءة رصيده' : generate.sanitizeError(e.message)}`);
        }
      }
      lines.push('');
      if (okCount) lines.push(`الإجمالي المقروء: ${Math.round(total * 1000) / 1000} عبر ${okCount} من ${pool.length} مفتاح.`);
      lines.push('ملاحظة: قراءة الرصيد تحتاج مفتاحًا بصلاحية Admin على deAPI.ai — وأي مهمة مكتملة تعرض تكلفتها الفعلية (💰 التكلفة).');
      return { text: lines.join('\n') };
    }
    default:
      return { text: `❌ أداة غير معروفة: ${name}. المتاح: generate_image، edit_image، generate_video، text_to_speech، merge_videos، list_models، check_balance، get_task، list_media`, isError: true };
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
