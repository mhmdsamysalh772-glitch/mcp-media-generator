// واجهة المزودات — كل خطأ يُرمى كـ ProviderError ليُصنَّف في classifyProviderError
import { ProviderError } from "../errors";

export interface ProviderTaskHandle {
  providerTaskId: string;
}

export interface ProviderCheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو وبعض الصور): تعيد معرّف المهمة لدى المزود
  createTask(key: string, model: string, input: Record<string, unknown>): Promise<ProviderTaskHandle>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(key: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: string, providerTaskId: string): Promise<ProviderCheckResult>;
}

// fetch مع مهلة ورسائل خطأ موحدة
export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<{ status: number; data: unknown }> {
  const { timeoutMs = 60_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    return { status: res.status, data };
  } catch (e) {
    // انقطاع شبكة/مهلة → temporary من وجهة نظر التصنيف
    throw new ProviderError(undefined, `network: ${String((e as Error)?.message || e)}`);
  } finally {
    clearTimeout(timer);
  }
}
