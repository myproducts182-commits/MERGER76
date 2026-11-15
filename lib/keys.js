// نظام المفاتيح المتسلسلة — قلب المشروع:
// الترتيب صارم حسب الإضافة (created_at ASC, id ASC)، والتبديل تلقائي عند أي خطأ
// مع تصنيف موحد للأخطاء، والنموذج المستخدم لا يرى أخطاء المفاتيح/الرصيد أبدًا.
const db = require('./db');

function maskKey(k) {
  const s = String(k || '');
  if (s.length <= 10) return s.slice(0, 3) + '••••••';
  return s.slice(0, 7) + '••••••••' + s.slice(-4);
}

// تصنيف أخطاء المزود (جدول 4.2 من المواصفة):
//   disabled  → مفتاح مرفوض (401/403 أو رسائل توثيق) → تعطيل تلقائي ثم التالي
//   exhausted → نفاد رصيد (402 أو رسائل رصيد) — يُفحص قبل 400 لأن بعض المزودين يرسلونه بحالة 400
//   params    → خطأ معطيات الطلب (400/422 أو رسائل سياسة محتوى) → توقف فورًا، تبديل المفاتيح لا يحلّه
//   provider  → الموديل غير مدعوم لدى المزود → انتقل للتالي
//   temporary → 429/5xx/شبكة/مهلة → انتقل للتالي والمفتاح يبقى سليمًا
function classifyProviderError(status, message) {
  const s = Number(status) || 0;
  const m = String(message || '').toLowerCase();
  const has = (re) => re.test(m);

  // نفاد الرصيد أولًا (قد يصل بحالة 400 لدى بعض المزودين)
  if (s === 402 || has(/insufficient|quota|balance|credit|out of credits|exhausted|充值|payment required/)) return 'exhausted';
  // مخالفة سياسة المحتوى = خطأ معطيات حتمي وليس مشكلة مفتاح
  if (has(/content policy|nsfw|safety system|policy violation|flagged/)) return 'params';
  // مفتاح مرفوض
  if (s === 401 || s === 403 || has(/invalid api key|unauthorized|forbidden|authentication|invalid token|api key/)) return 'disabled';
  // موديل غير مدعوم
  if (has(/model not found|unsupported model|no such model|unknown model/)) return 'provider';
  if (s === 400 || s === 422) return 'params';
  if (s === 429 || s >= 500) return 'temporary';
  if (s === 0) return 'temporary'; // شبكة/مهلة
  return 'temporary';
}

// تحديث عدّادات المفتاح وحالته بعد كل محاولة (نجاحًا أو فشلًا)
async function recordKeyAttempt(keyRow, { ok, errorClass, error }) {
  const usage = (keyRow.usage_count || 0) + 1;
  const success = ok ? (keyRow.success_count || 0) + 1 : (keyRow.success_count || 0);
  const fail = ok ? (keyRow.fail_count || 0) : (keyRow.fail_count || 0) + 1;
  const now = db.datetimeNow();
  const patch = {
    usage_count: usage, success_count: success, fail_count: fail,
    last_used_at: now, last_checked_at: now,
  };
  if (!ok) patch.last_error = String(error || '').slice(0, 500);
  else patch.last_error = null;
  // تصنيف الخطأ يضبط حالة المفتاح تلقائيًا — المستنزف يبقى في القاعدة دون عرقلة التالي
  if (!ok && (errorClass === 'disabled' || errorClass === 'exhausted')) patch.status = errorClass;
  if (ok && keyRow.status !== 'active') patch.status = 'active';
  await db.updateKey(keyRow.id, patch);
}

module.exports = { maskKey, classifyProviderError, recordKeyAttempt };
