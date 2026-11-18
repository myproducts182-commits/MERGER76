// إضافة مفتاح deAPI إلى قاعدة Turso (الإنتاج) بعد التحقق منه
// الاستخدام: DEAPI_NEW_KEY=sk-dp-... node scripts/add-prod-key.js
// المفتاح لا يُكتب في أي ملف — يُقرأ من متغير البيئة فقط، ويُطبع مقنّعًا.
const mask = (k) => (k && k.length > 16 ? k.slice(0, 10) + '…' + k.slice(-6) : '***');
const NEW_KEY = process.env.DEAPI_NEW_KEY;
if (!NEW_KEY || !NEW_KEY.startsWith('sk-dp-')) { console.error('❌ مرّر المفتاح: DEAPI_NEW_KEY=sk-dp-... node scripts/add-prod-key.js'); process.exit(1); }

const db = require('../lib/db');
const { fetchBalance, createSpeechJob, checkJob } = require('../lib/deapi');

async function validateByTts(key) {
  console.log('· تحقق بمهمة TTS مصغّرة (Kokoro, "hello")…');
  const { providerTaskId } = await createSpeechJob(key, { model: 'Kokoro', text: 'hello', lang: 'en-us', voice: 'af_sky', speed: 1, format: 'mp3', sample_rate: 24000 });
  console.log('· provider_task_id:', providerTaskId);
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await checkJob(key, providerTaskId);
    if (st.status === 'completed') {
      console.log('✅ المفتاح يعمل — مهمة TTS اكتملت، عينة صوت:', (st.urls && st.urls[0] || '(بلا رابط)').slice(0, 80) + '…', '| التكلفة:', st.price);
      return true;
    }
    if (st.status === 'failed') throw new Error('فشلت مهمة التحقق: ' + (st.error || ''));
  }
  throw new Error('انتهت مهلة التحقق (دقيقتان) دون اكتمال المهمة');
}

(async () => {
  console.log('المفتاح:', mask(NEW_KEY));
  let balance = null;
  try {
    const b = await fetchBalance(NEW_KEY);
    balance = b;
    console.log('· الرصيد:', balance);
  } catch (e) { console.log('· فحص الرصيد لم ينجح (قد لا يكون المفتاح Admin):', String(e.message).slice(0, 120)); }

  await validateByTts(NEW_KEY);

  const keys = await db.listKeys();
  const dup = (keys || []).find((k) => k.api_key === NEW_KEY);
  if (dup) {
    console.log('ℹ️ المفتاح موجود مسبقًا في القاعدة (id:', dup.id, ', label:', dup.label || '-', ') — لا حاجة للإضافة');
  } else {
    const ins = await db.insertKey({ provider: 'deapi', api_key: NEW_KEY, label: 'deAPI الرئيسي' });
    console.log('✅ أُضيف إلى قاعدة Turso — id:', ins && (ins.id || ins.lastID));
  }
  const after = await db.listKeys();
  console.log('· عدد المفاتيح في القاعدة الآن:', (after || []).length, '| التسميات:', (after || []).map((k) => k.label || mask(k.api_key)).join('، '));
})().catch((e) => { console.error('💥', e.message); process.exit(1); });
