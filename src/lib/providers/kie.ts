// مزود kie.ai — Jobs API الموحد (الأشكال هنا مُقاسة فعليًا بالنداءات الحقيقية، لا مخترَعة):
// POST https://api.kie.ai/api/v1/jobs/createTask  {"model","input"} → {"code":200,"data":{"taskId"}}
// GET  https://api.kie.ai/api/v1/jobs/recordInfo?taskId=… → {"code":200,"data":{"state","resultJson","failMsg"}}
// ملاحظة: HTTP دائمًا 200 والكود الحقيقي في الجسم (code) — لذا نمرر code كحالة للتصنيف.
import { ProviderError } from "../errors";
import type { MediaType } from "../models";
import { fetchJson, type ProviderAdapter, type ProviderCheckResult } from "./types";

const BASE = "https://api.kie.ai";

// رسم الـ input حسب نوع الوسائط وفق توثيق docs.kie.ai الرسمي
export function buildKieInput(type: MediaType, p: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (type === "image") {
    input.prompt = p.prompt;
    if (p.aspect_ratio) input.aspect_ratio = p.aspect_ratio;
    if (p.resolution) input.resolution = p.resolution;
    if (p.output_format) input.output_format = p.output_format;
    if (p.background && p.background !== "auto") input.background = p.background;
    // background يُطبق فقط عند 1K — إذا أُرسل غير auto و resolution ليست 1K نتجاهله
    if (input.background && input.resolution && input.resolution !== "1K") delete input.background;
  } else if (type === "video") {
    input.prompt = p.prompt;
    if (p.image_url) input.image_urls = [p.image_url];
    if (p.aspect_ratio) input.aspect_ratio = p.aspect_ratio;
    if (p.resolution) input.resolution = p.resolution;
    if (p.duration !== undefined) input.duration = Number(p.duration);
    if (p.enable_audio !== undefined) input.enable_audio = Boolean(p.enable_audio);
  }
  return input;
}

interface KieResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

function toProviderError(body: KieResponse, httpStatus: number): ProviderError {
  // الكود الحقيقي في الجسم (HTTP دائمًا 200 عند kie) — 401/402/422/429/500/501…
  const code = typeof body.code === "number" ? body.code : httpStatus;
  return new ProviderError(code, body.msg || `kie error ${code}`);
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, model, input) {
    const { status, data } = await fetchJson(`${BASE}/api/v1/jobs/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input }),
    });
    const body = data as KieResponse;
    if (body?.code !== 200 || !body?.data?.taskId) throw toProviderError(body, status);
    return { providerTaskId: String(body.data.taskId) };
  },

  async checkTask(key, providerTaskId): Promise<ProviderCheckResult> {
    const { status, data } = await fetchJson(
      `${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      { headers: { Authorization: `Bearer ${key}` }, timeoutMs: 20_000 }
    );
    const body = data as KieResponse;
    if (body?.code !== 200 || !body?.data) throw toProviderError(body, status);
    const d = body.data as {
      state?: string;
      resultJson?: string;
      failMsg?: string | null;
      progress?: number;
    };
    const state = String(d.state || "").toLowerCase();
    if (state === "success") {
      // resultJson نص JSON داخل JSON يحتاج JSON.parse ثانيًا
      let urls: string[] = [];
      try {
        const inner = JSON.parse(d.resultJson || "{}") as { resultUrls?: string[] };
        urls = Array.isArray(inner.resultUrls) ? inner.resultUrls.filter(Boolean) : [];
      } catch { /* لا روابط قابلة للتحليل */ }
      if (!urls.length) return { status: "failed", error: "اكتملت المهمة دون روابط نتائج قابلة للقراءة" };
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") {
      return { status: "failed", error: d.failMsg || "فشل المزود دون رسالة" };
    }
    // waiting | queuing | generating — تقدير تقريبي للتقدم
    const est = state === "waiting" ? 10 : state === "queuing" ? 20 : 50;
    return {
      status: "processing",
      progress: typeof d.progress === "number" ? Math.round(d.progress) : est,
    };
  },
};
