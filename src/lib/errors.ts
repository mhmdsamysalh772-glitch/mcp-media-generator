// تصنيف أخطاء المزودين — دالة موحدة تستخدمها كل نقاط الاتصال.
// الترتيب مهم: نفحص أنماط نفاد الرصيد قبل 400 لأن بعض المزودين يرسلون نفاد الرصيد بحالة 400.
export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

const DISABLED_RE = /invalid api key|unauthorized|forbidden|authentication|incorrect api key/i;
const EXHAUSTED_RE = /insufficient|quota|balance|credit|exhausted|out of credits|充值|نفد الرصيد/i;
const PROVIDER_RE = /model not found|unsupported model|model does not exist|no such model/i;
const REQUIRED_RE = /is required|required field|missing required|must be provided/i;

export function classifyProviderError(status: number | undefined, message: string | undefined): ErrorClass {
  const msg = String(message || "");
  if (status === 401 || status === 403 || DISABLED_RE.test(msg)) return "disabled";
  if (status === 402 || EXHAUSTED_RE.test(msg)) return "exhausted";
  if (PROVIDER_RE.test(msg) && [400, 404, 422].includes(status ?? 0)) return "provider";
  // بعض المزودين يرسلون أخطاء الحقول المطلوبة بأكواد غير قياسية (200/500) — هي خطأ معطيات لا محاكة
  if (REQUIRED_RE.test(msg) && !DISABLED_RE.test(msg) && !EXHAUSTED_RE.test(msg)) return "params";
  if ([400, 422].includes(status ?? 0)) return "params";
  // 429، 5xx، انقطاع شبكة، timeout، abort — وغير المصنّف
  return "temporary";
}

// هل الفئة من عائلة مشكلات المفتاح/الرصيد؟ (تُستخدم لاكتشاف فشل منتصف المهمة والتبديل الصامت)
export function isKeyOrBalanceClass(cls: ErrorClass): boolean {
  return cls === "disabled" || cls === "exhausted";
}

// خطأ مزود قابل للرمي — يحمل حالة HTTP ورسالة
export class ProviderError extends Error {
  status?: number;
  constructor(status: number | undefined, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

// هل رسالة فشل منتصف المهمة تُشير لمشكلة مفتاح/رصيد؟ (نمط المواصفة 4.3.2)
export function messageIndicatesKeyProblem(msg: string | undefined): boolean {
  return /insufficient|balance|credit|quota|402|401|unauthorized|invalid api key|exhausted/i.test(String(msg || ""));
}
