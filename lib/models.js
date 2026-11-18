// سجل الموديلات — الأسماء والحدود أدناه مأخوذة من استجابة GET /api/v2/models الفعلية لحساب deAPI
// (قسم images/generations و videos/generations) — لا نختلق أي حد غير مقاس.
// الكتالوج حي ومرتبط بالحساب؛ لذا تُستخدم حدود الكتالوج الحي عند توفره وتُعتبر القيم أدناه احتياطًا.

const MODELS = [
  // ---------- الصور (txt2img) — مزود deAPI ----------
  {
    slug: 'ZImageTurbo_INT8', type: 'image', provider: 'deapi', label: 'Z-Image Turbo INT8',
    aliases: ['z-image-turbo', 'z-image-turbo-int8', 'zimage', 'z-image', 'zimageturbo'],
    defaults: { width: 768, height: 768, steps: 8 },
    fallbackLimits: { min_width: 128, max_width: 2048, min_height: 128, max_height: 2048, min_steps: 1, max_steps: 50, dimension_multiple: 16, supports_negative_prompt: true },
  },
  {
    slug: 'Flux1schnell', type: 'image', provider: 'deapi', label: 'FLUX.1 Schnell 12B NF4',
    aliases: ['flux-schnell', 'flux.1-schnell', 'flux1-schnell', 'flux1schnell', 'flux'],
    defaults: { width: 768, height: 768, steps: 4 },
    fallbackLimits: { min_width: 256, max_width: 2048, min_height: 256, max_height: 2048, min_steps: 1, max_steps: 10, dimension_multiple: 128, supports_negative_prompt: true },
  },
  {
    slug: 'Flux_2_Klein_4B_BF16', type: 'image', provider: 'deapi', label: 'FLUX.2 Klein 4B BF16',
    aliases: ['flux-2-klein', 'flux.2-klein-4b-bf16', 'flux2-klein-4b-bf16', 'flux-2-klein-4b', 'flux2'],
    defaults: { width: 1024, height: 1024, steps: 4 },
    fallbackLimits: { min_width: 256, max_width: 1536, min_height: 256, max_height: 1536, min_steps: 4, max_steps: 4, dimension_multiple: 16, supports_negative_prompt: false },
  },
  {
    slug: 'ZAnimeDistill_8Step_INT8', type: 'image', provider: 'deapi', label: 'Z-Anime Distill 8-Step INT8',
    aliases: ['z-anime', 'z-anime-8step', 'z-anime-distill', 'zanime', 'z-anime-distill-8-step-int8'],
    defaults: { width: 768, height: 768, steps: 8 },
    fallbackLimits: { min_width: 128, max_width: 2048, min_height: 128, max_height: 2048, min_steps: 4, max_steps: 16, dimension_multiple: 16, supports_negative_prompt: true },
  },
  // ---------- تحرير الصور (img2img: صورة+نص→صورة) — مزود deAPI ----------
  {
    slug: 'QwenImageEdit_Plus_NF4', type: 'edit', provider: 'deapi', label: 'Qwen Image Edit Plus NF4',
    aliases: ['qwen-image-edit', 'qwen-image-edit-plus', 'qwenedit', 'qwen-image-edit-plus-nf4', 'nano-banana-21'],
    defaults: { seed: -1 },
    fallbackLimits: { supports_steps: false, max_images: 5 },
  },
  // ---------- الفيديو (txt2video / img2video) ----------
  {
    slug: 'Ltx2_5_22B_Dist_INT8', type: 'video', provider: 'deapi', label: 'LTX-2.5 22B Distilled INT8', featured: true,
    aliases: ['ltx-2.5', 'ltx-2.5-22b', 'ltx-2.5-22b-distilled-int8', 'ltx25', 'ltx2_5', 'ltx-25'],
    // الحدود المقاسة: fps مثبت 24، الإطارات 49–241، الضلعان 512–1344 (مضاعف 64)، البكسلات ≤ 1032192، النسبة ≤ 2
    defaults: { width: 768, height: 768, frames: 120, fps: 24 },
    fallbackLimits: { min_side: 512, max_side: 1344, max_width: 1344, min_width: 512, max_height: 1344, min_height: 512, min_frames: 49, max_frames: 241, min_fps: 24, max_fps: 24, dimension_multiple: 64, max_pixels: 1032192, max_ratio: 2, supports_negative_prompt: false, supports_steps: false, supports_guidance: false, supports_last_frame: true },
  },
  {
    slug: 'MiniMaxH3_33B_Turbo_INT8', type: 'video', provider: 'deapi', label: 'MiniMax H3 33B Turbo INT8',
    aliases: ['minimax-h3', 'minimaxh3', 'minimax-h3-33b-turbo-int8'],
    defaults: { width: 1344, height: 768, frames: 124, fps: 24 },
    fallbackLimits: { min_side: 512, max_side: 1344, max_width: 1344, min_width: 512, max_height: 1344, min_height: 512, min_frames: 56, max_frames: 243, min_fps: 24, max_fps: 24, dimension_multiple: 32, max_pixels: 1032192, supports_negative_prompt: false, supports_steps: false, supports_guidance: false, supports_last_frame: true },
  },
  {
    slug: 'Ltx2_3_22B_Dist_INT8', type: 'video', provider: 'deapi', label: 'LTX-2.3 22B Distilled INT8',
    aliases: ['ltx-2.3', 'ltx23', 'ltx-2-3-22b', 'ltx2_3'],
    defaults: { width: 768, height: 768, frames: 121, fps: 24 },
    fallbackLimits: { min_fps: 24, max_fps: 24, supports_negative_prompt: false, supports_steps: false, supports_guidance: false },
  },
  {
    slug: 'Ltxv_13B_0_9_8_Distilled_FP8', type: 'video', provider: 'deapi', label: 'LTX-Video 13B 0.9.8 Distilled FP8',
    aliases: ['ltx-video-13b', 'ltxv-13b', 'ltx-13b', 'ltxvideo'],
    defaults: { width: 768, height: 512, frames: 121, fps: 30 },
    fallbackLimits: { min_fps: 30, max_fps: 30, supports_negative_prompt: false, supports_steps: true, supports_guidance: false },
  },
  // ---------- تحويل النص إلى كلام (txt2speech) — مزود deAPI ----------
  {
    slug: 'Kokoro', type: 'speech', provider: 'deapi', label: 'Kokoro TTS', featured: true,
    aliases: ['kokoro-tts', 'kokoro-82m', 'kokoro'],
    defaults: { lang: 'en-us', voice: 'af_sky', speed: 1, format: 'mp3', sample_rate: 24000 },
    fallbackLimits: { min_speed: 0.5, max_speed: 2 },
  },
  {
    slug: 'Chatterbox', type: 'speech', provider: 'deapi', label: 'Chatterbox TTS',
    aliases: ['chatterbox-tts', 'chatterbox'],
    defaults: { lang: 'en', speed: 1, format: 'mp3', sample_rate: 24000 },
    fallbackLimits: {},
  },
  {
    slug: 'Qwen3_TTS_12Hz_1_7B_CustomVoice', type: 'speech', provider: 'deapi', label: 'Qwen3 TTS Custom Voice',
    aliases: ['qwen3-tts', 'qwen3-tts-custom', 'qwen3-tts-customvoice'],
    defaults: { lang: 'en', speed: 1, format: 'mp3', sample_rate: 24000, mode: 'custom_voice' },
    fallbackLimits: {},
  },
  {
    slug: 'Qwen3_TTS_12Hz_1_7B_Base', type: 'speech', provider: 'deapi', label: 'Qwen3 TTS Base — استنساخ صوتي (voice_clone)',
    aliases: ['qwen3-tts-base', 'qwen3-tts-voice-clone', 'qwen3-tts-clone'],
    defaults: { lang: 'en', speed: 1, format: 'mp3', sample_rate: 24000, mode: 'voice_clone' },
    fallbackLimits: {},
  },
  {
    slug: 'Qwen3_TTS_12Hz_1_7B_VoiceDesign', type: 'speech', provider: 'deapi', label: 'Qwen3 TTS Voice Design',
    aliases: ['qwen3-tts-voicedesign', 'qwen3-tts-voice-design'],
    defaults: { lang: 'en', speed: 1, format: 'mp3', sample_rate: 24000, mode: 'voice_design' },
    fallbackLimits: {},
  },
  // ---------- الفيديو — مزود Google Flow (Gemini Interactions API) ----------
  // gemini-omni-1.2-flash هو موديل توليد الفيديو الرسمي عبر Gemini API
  // بعد إيقاف موديلات Veo preview (أكتوبر 2026) — الصوت الأصلي مدمج في المقطع.
  {
    slug: 'GeminiOmni12Flash', type: 'video', provider: 'google-flow', label: 'Google Omni 1.2 Flash (Google Flow)',
    aliases: ['gemini-omni-1.2-flash', 'gemini-omni', 'omni-1.2-flash', 'omni-flash', 'google-flow', 'google-omni', 'veo'],
    apiModel: 'gemini-omni-1.2-flash',
    defaults: { duration: 10, aspect_ratio: '16:9', resolution: '720p' },
    fallbackLimits: { min_duration: 3, max_duration: 15, aspects: ['16:9', '9:16'], resolutions: ['360p', '720p', '1080p', '4k'], supports_negative_prompt: false, supports_steps: false, supports_image_input: true },
  },
];

// توحيد الاسم: أحرف صغيرة + حذف الفواصل/النقاط/الشرطات/السبيسات — يقبل الصيغ البديلة بالنقاط
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-\.]/g, '');
}

function resolveModel(name) {
  const n = normalize(name);
  if (!n) return null;
  return MODELS.find((m) => normalize(m.slug) === n || m.aliases.some((a) => normalize(a) === n)) || null;
}

function byType(type) {
  return MODELS.filter((m) => m.type === type);
}

// نسبة الأبعاد المسموحة → [width, height] قيم آمنة لـ LTX-2.5 (مضاعفة 64، ضمن الحدود المقاسة)
const ASPECTS = {
  '1:1': [768, 768], '16:9': [1024, 576], '9:16': [576, 1024],
  '4:3': [1024, 768], '3:4': [768, 1024], 'auto': null,
};

function aspectToSize(ar) {
  const v = ASPECTS[String(ar || '').toLowerCase()];
  return v ? { width: v[0], height: v[1] } : null;
}

// تثبيت قيمة داخل حدود مع تقريب لمضاعف العدد المطلوب
function clamp(v, min, max, mult) {
  let x = Math.round(Number(v));
  if (Number.isNaN(x)) x = min;
  if (mult && mult > 1) x = Math.round(x / mult) * mult;
  return Math.max(min, Math.min(max, x));
}

// مدة بالثواني → إطارات ضمن حدود الموديل (الافتراضي fps من الموديل)
function secondsToFrames(sec, def) {
  const fps = (def.fallbackLimits && def.fallbackLimits.max_fps) || (def.defaults && def.defaults.fps) || 24;
  const frames = Math.round(Number(sec) * fps);
  const lim = def.fallbackLimits || {};
  return clamp(frames, lim.min_frames || 49, lim.max_frames || 241);
}

module.exports = { MODELS, resolveModel, byType, aspectToSize, clamp, secondsToFrames, normalize };
