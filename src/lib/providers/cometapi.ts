// مزود CometAPI — وفق التوثيق الرسمي الحالي (apidoc.cometapi.com):
// - الصور متزامنة: POST https://api.cometapi.com/v1/images/generations (متوافق OpenAI)
//   الاستجابة data[] قد تحمل url أو b64_json (حسب الموديل). بلا تنزيل أي وسائط:
//   إن جاء b64_json فقط نبني data URI كرابط عرض (نخزن رابطًا نصيًا فقط، لا ملفًا).
// - الفيديو غير متزامن: POST https://api.cometapi.com/v1/videos (multipart/form-data)
//   → {id, task_id, status: queued|in_progress|completed|failed|error, progress}
//   والاستعلام: GET https://api.cometapi.com/v1/videos/{id} حتى status=completed.
import { ProviderError } from "../errors";
import type { MediaType } from "../models";
import { fetchJson, type ProviderAdapter, type ProviderCheckResult } from "./types";

const BASE = "https://api.cometapi.com/v1";

// روابط النتائج من استجابة الفيديو — حقول محتملة دفاعية (التوثيق غير جامع لكل الموديلات)
function extractVideoUrls(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && /^https?:\/\//i.test(v)) out.push(v);
  };
  push(data.url);
  push(data.video_url);
  push(data.videoUrl);
  if (Array.isArray(data.output)) data.output.forEach(push);
  if (Array.isArray(data.data)) {
    for (const item of data.data as Record<string, unknown>[]) {
      if (item && typeof item === "object") {
        push((item as Record<string, unknown>).url);
        push((item as Record<string, unknown>).video_url);
      } else push(item);
    }
  }
  if (typeof data.result === "string") push(data.result);
  if (Array.isArray(data.result)) data.result.forEach(push);
  return out;
}

function errFromBody(status: number, body: Record<string, unknown>): ProviderError {
  // الأخطاء: {code,message} أو {error:{code,message,type}}
  const nested = body.error as Record<string, unknown> | undefined;
  const msg = String(body.message ?? nested?.message ?? body.msg ?? `cometapi error ${status}`);
  return new ProviderError(status, msg);
}

export const cometApiAdapter: ProviderAdapter = {
  async createImageSync(key, input) {
    const body: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
      n: 1,
    };
    if (input.size) body.size = input.size;
    if (input.output_format) body.output_format = input.output_format;
    if (input.background) body.background = input.background;

    const { status, data } = await fetchJson(`${BASE}/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      timeoutMs: 120_000,
    });
    const d = data as { data?: { url?: string; b64_json?: string }[]; error?: unknown; message?: string };
    if (status >= 400) throw errFromBody(status, data as Record<string, unknown>);
    const items = d?.data ?? [];
    const urls = items
      .map((it) => (it?.url ? String(it.url) : it?.b64_json ? `data:image/png;base64,${it.b64_json}` : ""))
      .filter(Boolean);
    if (!urls.length) throw new ProviderError(status, "استجابة الصور لا تحتوي روابط قابلة للاستخدام");
    return { urls };
  },

  async createTask(key, model, input) {
    // نقطة الفيديو تقبل multipart/form-data — نبنيه عبر FormData (Node 18+)
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", String(input.prompt ?? ""));
    if (input.duration !== undefined) form.append("seconds", String(input.duration));
    if (input.size) form.append("size", String(input.size));
    else if (input.resolution) {
      // تحويل 480p/720p/1080p إلى أقرب WxH مقبول (16:9)
      const map: Record<string, string> = { "480p": "864x480", "720p": "1280x720", "1080p": "1920x1080" };
      form.append("size", map[String(input.resolution)] ?? "864x480");
    }
    if (input.image_url) form.append("input_reference", String(input.image_url));

    const { status, data } = await fetchJson(`${BASE}/videos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      timeoutMs: 60_000,
    });
    const d = data as Record<string, unknown>;
    if (status >= 400) throw errFromBody(status, d);
    const id = d.id ?? d.task_id;
    if (!id) throw new ProviderError(status, "استجابة إنشاء الفيديو بلا معرّف مهمة");
    return { providerTaskId: String(id) };
  },

  async checkTask(key, providerTaskId): Promise<ProviderCheckResult> {
    const { status, data } = await fetchJson(`${BASE}/videos/${encodeURIComponent(providerTaskId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      timeoutMs: 30_000,
    });
    const d = data as Record<string, unknown>;
    if (status >= 400) throw errFromBody(status, d);
    const st = String(d.status ?? "").toLowerCase();
    const progress = typeof d.progress === "number" ? Math.round(d.progress) : undefined;
    if (st === "completed" || st === "success") {
      const urls = extractVideoUrls(d);
      if (!urls.length) return { status: "failed", error: "اكتملت المهمة دون روابط نتائج" };
      return { status: "completed", urls, progress: 100 };
    }
    if (st === "failed" || st === "error") {
      return { status: "failed", error: String(d.message ?? d.error ?? "فشل المزود") };
    }
    return { status: "processing", progress: progress ?? (st === "in_progress" ? 50 : 20) };
  },
};
