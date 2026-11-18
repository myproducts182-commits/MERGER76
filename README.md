# MERGER76 — MCP Media Generator

**خادم MCP لتوليد الوسائط بالذكاء الاصطناعي + لوحة إدارة عربية** — توليد صور وفيديو عبر [deAPI.ai](https://deapi.ai)، تخزين المهام والمفاتيح في قاعدة [Turso](https://turso.tech) عبر HTTP، ونشر على [Vercel](https://vercel.com) بدون أي خطوة بناء وبدون أي اعتماديات خارجية (Node.js خالص).

---

## ✨ المزايا

| القدرة | التفاصيل |
|---|---|
| 🖼️ توليد الصور | Z-Image Turbo (افتراضي)، FLUX.1 Schnell، FLUX.2 Klein، Z-Anime — عبر deAPI |
| 🎬 توليد الفيديو | **LTX-2.5 22B Distilled INT8** (افتراضي) بصوت متزامن، MiniMax H3، LTX-2.3، LTX-Video 13B — عبر deAPI · **Google Omni 1.2 Flash (Google Flow)** — عبر Gemini API |
| 🔌 مزودان | **deAPI.ai** للصور والفيديو · **Google Flow** (Gemini Interactions API) لفيديو `gemini-omni-1.2-flash` 3–15 ثانية بنسب 16:9/9:16 ودقة حتى 4K — مفتاحان منفصلان وتبديل تسلسلي مستقل لكل مزود |
| 🔗 دمج الفيديو | أداة `merge_videos` عبر خدمة دمج خارجية (اختيارية — تضبطها بمتغير `MERGER_API_BASE`) |
| 🔑 تبديل مفاتيح تسلسلي | أول مفتاح أُضيف يُجرَّب أولًا، ثم التالي ثم التالي… مع تبديل **فوري وصامت** عند أي خطأ أو نفاد رصيد — المهمة تستأنف بنفس `task_id` والعميل لا يرى أخطاء المفاتيح أبدًا |
| 🗄️ قاعدة Turso | المهام والمفاتيح والإحصائيات كلها في libSQL عبر HTTP — مناسب للـ serverless |
| 🧩 خادم MCP | 7 أدوات على `/mcp` (Streamable HTTP، عديم الحالة) تعمل مع ChatGPT / Claude Desktop / Cursor / Windsurf / Cline |
| 📊 لوحة عربية RTL | استوديو توليد مباشر، مدير مفاتيح، لوحة مهام تتحدث كل 5 ثوانٍ، إعدادات ربط جاهزة للنسخ |

---

## 🚀 النشر على Vercel (خطوة بخطوة)

### 1) جهّز قاعدة Turso (مرة واحدة، مجانًا)

```bash
npm i -g @turso/cli
turso auth login
turso db create merger76
turso db show merger76 --url          # ← هذا TURSO_DATABASE_URL
turso db tokens create merger76       # ← هذا TURSO_AUTH_TOKEN
```

### 2) انشر المشروع

**الطريقة الأسهل — زر النشر:** افتح الرابط التالي وسيطلب منك إدخال متغيري Turso أثناء الاستيراد:

```
https://vercel.com/new/clone?repository-url=https://github.com/myproducts182-commits/MERGER76&env=TURSO_DATABASE_URL,TURSO_AUTH_TOKEN
```

**أو يدويًا:**

1. Vercel → **Add New → Project** → اختر مستودع `MERGER76`.
2. في خطوة الإعداد أضف متغيري البيئة (Environment Variables):

| المتغير | إلزامي؟ | القيمة |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | `libsql://<db-name>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | ✅ | التوكن بصلاحيات الكتابة |
| `MERGER_API_BASE` | اختياري | عنوان خدمة دمج الفيديو (Video Merger API v2) |
| `MCP_ACCESS_TOKEN` | اختياري | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `ADMIN_TOKEN` | اختياري | حماية إضافة/حذف المفاتيح (ترويسة `X-Admin-Token`) |
| `DEAPI_IMAGE_MODEL` / `DEAPI_VIDEO_MODEL` | اختياري | تجاوز الموديلين الافتراضيين لـ deAPI |
| `GOOGLE_FLOW_PUBLIC_BASE` | اختياري | نطاق عام لروابط فيديو Google Flow — يُستنتج تلقائيًا من Vercel (`VERCEL_PROJECT_PRODUCTION_URL`)، اضبطه فقط للتشغيل المحلي خارج Vercel |
| `BRIDGE_TOKEN` | اختياري | توكن الجسر المحلي لـ Google Flow (نفس القيمة في `bridge/bridge.env` على جهازك) — بدونه تبقى أدوات `flow_*` تعيد رسالة إعداد واضحة |
| `FLOW_PUBLIC_BASE` | اختياري | نطاق عام لروابط `/api/flow/file/` — يُستنتج تلقائيًا من Vercel |

3. **Deploy** — لا حاجة لأي إعداد آخر (لا بناء، لا اعتماديات).

### 3) أضف المفاتيح

بعد فتح رابط المشروع على Vercel: من بطاقة **مدير المفاتيح** أضف مفتاحك لكل مزود:

- **deAPI.ai** (`sk-dp-…`): من deapi.ai — يعمل مع كل موديلات الصور والفيديو.
- **Google Flow** (`AIza…`): أنشئه من [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — يعمل مع موديل `Google Omni 1.2 Flash` للفيديو فقط (يتطلب تفعيل الفوترة على مشروع Google لأن موديلات الفيديو ليست في الطبقة المجانية).

المفاتيح تُخزَّن في Turso وتظهر **مقنَّعة** دائمًا (`sk-dp-2••••••••06ae`). أضف أكثر من مفتاح لكل مزود لتفعيل التبديل التسلسلي المستقل.

> **ملاحظة — روابط فيديو Google Flow:** روابط Files API لدى Google تتطلب مفتاحًا للتنزيل، لذا يُقدَّم الفيديو عبر وسيط التطبيق نفسه: `https://<your-app>.vercel.app/api/gf/{task_id}` — رابط عام يعمل مع المتصفح وخدمة الدمج دون كشف أي مفتاح، ويبقى صالحًا طوال بقاء الملف لدى Google (~48 ساعة).

### 3-ب) Google Flow عبر الجسر المحلي (كريدتات اشتراكك — بدون أي مفتاح API)

خلافًا لمزود Gemini أعلاه، أدوات `flow_*` الثلاث عشرة تعمل على **موقع flow.google نفسه**
من متصفحك على جهازك — جلسة Google الخاصة بك وكريدتات اشتراكك، بلا أي مفتاح API
(لا يوجد API رسمي من Flow). المكونات:

- **على Vercel** (هذا المستودع): قائمة أوامر ووسيط بث — أضف فقط متغير `BRIDGE_TOKEN`
- **على جهازك Windows** (مجلد `bridge/`): `install-windows.bat` يثبّت ويشغّل تلقائيًا
  جسرًا يسحب الأوامر وينفذها عبر Chrome DevTools Protocol في جلسة متصفح مخصصة
  تسجل دخولك إليها مرة واحدة

البدء الآمن: `FAKE=1` يحاكي كل شيء بدون متصفح وبدون كريدتات — تحققت منه محليًا
(أمر → تقدم → نتيجة → بث ملف مطابق بايتًا بايتًا). الدليل الكامل:
[`bridge/README-BRIDGE.md`](bridge/README-BRIDGE.md).

### 4) تحقق من الجهوزية

```bash
curl https://<your-app>.vercel.app/api/health
# {"ok":true,"database":"turso-connected",...}
```

---

## 🧩 ربط عملاء MCP

عنوان الخادم: `https://<your-app>.vercel.app/mcp`

**ChatGPT (Settings → Apps & Connectors → Create → Custom connector):**
```json
{"mcpServers": { "media-generator": { "url": "https://merger76.vercel.app/mcp" } }}
```
- ضع الرابط **بدون خط مائل زائد** في النهاية: `https://merger76.vercel.app/mcp` ✅ وليس `/mcp/` ❌
- اختر **Authentication = No authentication** (الخادم عام افتراضيًا — إن ضبطت `MCP_ACCESS_TOKEN` فChatGPT لا يدعم ترويسات مخصصة، أوقف الحماية أو استخدم عميلًا يدعمها).
- إن لم تظهر خيارات «Create» فعّل **Developer mode** أولًا: Settings → Apps & Connectors → Advanced settings → ✅ Developer mode (يتطلب خطة Plus/Pro).
- الخادم يعرض أداتَي `search` و`fetch` الإلزاميتين لموصلات Deep Research، فيعمل في القسمين: Developer mode و Deep Research connectors.

**Claude Desktop (`claude_desktop_config.json`):**
```json
{"mcpServers": { "media-generator": { "type": "http", "url": "https://<your-app>.vercel.app/mcp" } }}
```

**Cursor / Windsurf / Cline (`mcp.json`):** نفس صيغة ChatGPT أعلاه.

سير عمل الأدوات: استدعِ أداة التوليد المناسبة → إن اكتملت خلال نافذة الانتظار ستحصل على الرابط فورًا، وإلا ستحصل على `task_id` → استدعِ `get_task` كل ~10 ثوانٍ حتى تكتمل المهمة وتظهر الروابط. الخادم يبدّل المفاتيح تلقائيًا بصمت، فلا تتوقف ولا تُحذّر المستخدم من أي شيء متعلق بالمفاتيح أو الرصيد. عند الشك في اسم الموديل أو الصوت استدعِ `list_models` أولًا، ولعرض الرصيد `check_balance`. كل مهمة مكتملة تعرض تكلفتها الفعلية (💰 التكلفة).

### الأدوات التسع

| الأداة | الوصف |
|---|---|
| `generate_image` | **صورة من نص** — اختيار الموديل، الأبعاد/النسبة، الخطوات، وصف سلبي، بذرة |
| `edit_image` | **صورة من صورة ونص** — تحرير صورة موجودة بتعليقة نصية (Qwen Image Edit / FLUX.2 Klein) مع دمج حتى 5 صور |
| `generate_video` | **فيديو من نص أو من صورة** — LTX-2.5 بصوت متزامن؛ `image_url` يجعل الصورة الإطار الأول (صورة إلى فيديو)، مدة 2–10 ثوانٍ |
| `text_to_speech` | **تحويل النص إلى كلام** mp3 — Kokoro / Chatterbox / Qwen3-TTS (صوت جاهز، استنساخ صوتي من مقطع مرجعي، أو تصميم صوت بالوصف) |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب: `urls` روابط مباشرة أو `task_ids` لمهام مكتملة — الملف الناتج يُحذف من خدمة الدمج بعد ~24 ساعة |
| `list_models` | **كل النماذج المتاحة** حية من deAPI: الصور، التحرير، الفيديو، الصوت — مع الأسعار واللغات والأصوات |
| `check_balance` | **الرصيد المتبقي** لكل مفتاح deAPI والمجموع — الرصيد الذي سيُستهلك عند التوليد (يتطلب مفتاحًا بصلاحية Admin للقراءة) |
| `get_task` | تتبع أي مهمة (توليد أو دمج) مع تحديث حي من المزود |
| `list_media` | أحدث الوسائط المخزنة بروابطها لاسترجاع نتائج سابقة |

> ملاحظة: النسخة 1.6.0 أعادت القائمة الأساسية البسيطة (بدون أدوات search/fetch/flow_*) وأضافت التحرير والصوت والنماذج والرصيد — نقاط الجسر `/api/flow/*` ما زالت متاحة عبر HTTP لمن يحتاجها.

---

## 🔌 واجهة REST

| Method | المسار | الوظيفة |
|---|---|---|
| `GET` | `/api/health` | الجهوزية: قاعدة البيانات + الموديلات + خدمة الدمج |
| `GET` | `/api/models` | كتالوج الموديلات الحي من deAPI مدموجًا مع السجل المحلي (الصور/التحرير/الفيديو/الصوت) |
| `GET` | `/api/balance` | رصيد كل مفتاح deAPI نشط والمجموع (يتطلب مفتاحًا بصلاحية Admin للقراءة) |
| `GET` / `POST` | `/api/keys` | قائمة المفاتيح (مقنَّعة) / إضافة مفتاح |
| `PATCH` / `DELETE` | `/api/keys/{id}` | تعطيل–تنشيط / حذف |
| `GET` | `/api/tasks?limit=&type=&status=` | أحدث المهام + الإحصائيات |
| `GET` / `DELETE` | `/api/tasks/{id}` | مهمة مع تحديث حي / حذف |
| `POST` | `/api/generate` | `{type:"image"|"edit"|"video"|"speech", prompt/text, …}` → مهمة مكتملة أو `task_id` |
| `POST` | `/api/merge` | `{urls:[…]}` أو `{task_ids:[…]}` → دمج عبر خدمة الدمج |
| `POST/DELETE/GET` | `/mcp` | خادم MCP (JSON-RPC عبر Streamable HTTP) |

### أمثلة

```bash
# توليد صورة (تُعاد مكتملة إن اكتملت خلال نافذة الانتظار)
curl -X POST https://<your-app>.vercel.app/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"type":"image","prompt":"A fox in a neon forest","width":768,"height":768}'

# توليد فيديو 5 ثوانٍ بـ LTX-2.5 (يعيد task_id — تابعه من /api/tasks/{id})
curl -X POST https://<your-app>.vercel.app/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"type":"video","prompt":"Ocean waves at sunset, cinematic","duration":5}'

# متابعة مهمة
curl https://<your-app>.vercel.app/api/tasks/<task_id>
```

---

## 🔒 نظام المفاتيح المتسلسلة (قلب المشروع)

- **الترتيب صارم حسب الإضافة** (`created_at ASC, id ASC`) — ليس round-robin.
- عند أي خطأ يُصنَّف تلقائيًا: `disabled` (مفتاح مرفوض → يُعطَّل وينتقل للتالي) / `exhausted` (نفاد رصيد → يبقى في القاعدة وينتقل للتالي) / `params` (خطأ معطيات → توقف فوري) / `temporary` (429 أو 5xx → انتقال فوري).
- فشل منتصف المهمة بسبب مفتاح/رصيد → **إعادة إنشاء نفس المهمة بنفس `task_id`** على المفتاح التالي دون توقف.
- فشل على كل المفاتيح → المهمة تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة 45 ثانية).
- إخفاء المفاتيح إلزامي في كل الاستجابات (`maskKey`)، ورسائل أخطاء المفاتيح/الرصيد لا تخرج للعميل أبدًا.

## 📐 قواعد جوهرية

1. **روابط فقط** — لا يُنزَّل أي وسائط إلى السيرفر (إلا الإطار الأول للفيديو عازلًا في الذاكرة لرفعه multipart — بلا تخزين).
2. روابط النتائج من المزود صالحة **~5 ساعات** (روابط موقّعة) — حمّل نسختك أو استخدمها سريعًا.
3. نافذة الانتظار الفعلية ≤ 50 ثانية لملاءمة مهلة دوال Vercel — بعدها يُعاد `task_id` ويتابع العميل بـ `get_task` ولا يتوقف شيء.
4. بلا اعتماديات: `@libsql/client` مستبدلة بعميل HTTP خفيف عبر `/v2/pipeline`، وبروتوكول MCP منفَّذ يدويًا بوضع عديم الحالة (أكثر موثوقية في serverless).
5. `.env*` مستثنى من Git منذ أول commit — لا أسرار في المستودع إطلاقًا.

## 💻 التشغيل المحلي

```bash
cp .env.example .env        # ضع قيم Turso
npm run dev                 # خادم تطوير يحاكي Vercel على المنفذ 3000
# الواجهة: http://localhost:3000 — الخادم: http://localhost:3000/mcp — الصحة: /api/health
```

## 🗂️ البنية

```
api/            دوال Vercel Serverless (health, models, keys, tasks, generate, merge, mcp)
lib/            المحرك: turso (HTTP client)، db، models، deapi، keys، merger، generate، mcp-server
public/         لوحة الواجهة العربية RTL (ملف واحد مكتفٍ بذاته)
scripts/        dev-server.js — خادم تطوير يحاكي Vercel (يحلّل المسارات الديناميكية)
```

## 📋 الحدود المعروفة

- خطة Vercel المجانية: مهلة الدالة حتى 60 ثانية (مضبوطة في `vercel.json`) وحجم الطلب ~4.5MB.
- كتالوج موديلات deAPI مرتبط بالحساب — يُكتشف تلقائيًا من `GET /api/v2/models` ولا تُثبَّت الأسماء.
- الفيديو يستهلك رصيدًا أكبر من الصور (مثال مقاس: مقطع 512×512 و49 إطارًا ≈ $0.047، صورة 512×512 بـ Z-Image Turbo ≈ $0.004).
