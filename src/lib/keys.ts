// نظام المفاتيح المتسلسلة — قلب المشروع:
// التجربة تسلسلية صارمة بترتيب الإضافة (created_at ASC, id ASC) وليس round-robin.
// المفتاح المستنزف يبقى في القاعدة والقائمة؛ الاستثناء الوحيد هو التعطيل اليدوي (disabled).
import { randomUUID } from "crypto";
import { getDb, ensureSchema, type ApiKeyRow } from "./turso";

export type ProviderId = "kie" | "cometapi";

// إخفاء المفتاح إلزامي في كل الاستجابات — لا يُعاد المفتاح الكامل أبدًا
export function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 3) + "••••";
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

// جلب المفاتيح غير المعطّلة لهذه المزودات بالترتيب التسلسلي الصارم.
// rowid يمثل ترتيب الإضافة الفعلي — لأن created_at بدقة الثانية قد يتساوى بين مفتاحين
// متتاليين، فنضعه أولًا ثم نحسم التعادل بـ rowid لضمان «أول مفتاح أُضيف يُجرَّب أولًا».
export async function getKeyPool(providers: string[]): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const res = await getDb().execute({
    sql: `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${placeholders}) ORDER BY created_at ASC, rowid ASC`,
    args: providers,
  });
  return res.rows as unknown as ApiKeyRow[];
}

// تحديث عدّادات المفتاح — تُحدَّث دائمًا بعد كل محاولة (نجاح أو فشل)
export async function bumpKeyCounters(
  keyId: string,
  opts: { ok: boolean; error?: string; lastChecked?: boolean } = { ok: false }
): Promise<void> {
  await getDb().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = datetime('now'),
            last_checked_at = CASE WHEN ? THEN datetime('now') ELSE last_checked_at END,
            last_error = ?
          WHERE id = ?`,
    args: [opts.ok ? 1 : 0, opts.ok ? 0 : 1, opts.lastChecked ? 1 : 0, opts.error ?? null, keyId],
  });
}

// تعليم حالة المفتاح تلقائيًا (disabled عند رفضه، exhausted عند نفاد رصيده — يبقى في القاعدة)
export async function markKeyStatus(keyId: string, status: "active" | "exhausted" | "disabled", error?: string): Promise<void> {
  await getDb().execute({
    sql: `UPDATE api_keys SET status = ?, last_error = COALESCE(?, last_error), last_checked_at = datetime('now') WHERE id = ?`,
    args: [status, error ?? null, keyId],
  });
}

// ===== إدارة المفاتيح (للواجهة) =====
export async function listKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const res = await getDb().execute("SELECT * FROM api_keys ORDER BY created_at ASC, rowid ASC");
  return res.rows as unknown as ApiKeyRow[];
}

export async function addKey(provider: string, apiKey: string, label?: string): Promise<{ ok: boolean; error?: string; id?: string }> {
  await ensureSchema();
  if (!["kie", "cometapi"].includes(provider)) return { ok: false, error: "المزود غير معروف (المتاح: kie، cometapi)" };
  if (!apiKey || apiKey.length < 8) return { ok: false, error: "المفتاح قصير جدًا أو فارغ" };
  // رفض التكرار لنفس المزود
  const dup = await getDb().execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ?",
    args: [provider, apiKey],
  });
  if (dup.rows.length) return { ok: false, error: "هذا المفتاح مضاف مسبقًا لنفس المزود" };
  const id = randomUUID();
  await getDb().execute({
    sql: "INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)",
    args: [id, provider, label ?? "", apiKey],
  });
  return { ok: true, id };
}

export async function setKeyEnabled(id: string, disabled: boolean): Promise<boolean> {
  await ensureSchema();
  // التنشيط اليدوي يعيد المفتاح إلى active حتى لو كان مستنزفًا سابقًا
  const res = await getDb().execute({
    sql: "UPDATE api_keys SET status = ?, last_error = NULL WHERE id = ?",
    args: [disabled ? "disabled" : "active", id],
  });
  return res.rowsAffected > 0;
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const res = await getDb().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  return res.rowsAffected > 0;
}
