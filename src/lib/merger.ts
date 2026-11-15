// عميل خدمة دمج الفيديو — Video Merger API v2 (بلا مفاتيح أو توثيق)
// العنوان من MERGER_API_BASE. دفاعي في تحليل الحالة دائمًا.
const BASE = (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");

export interface MergerJob {
  jobId: string;
  status: "queued" | "processing" | "done" | "failed";
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  expiresAt?: string;
}

export function mergerConfigured(): boolean {
  return /^https?:\/\//.test(BASE);
}

// أكمل: done|completed|complete|success|succeeded|finished — فشل: error|failed|failure|cancelled
const DONE_RE = /^(done|completed|complete|success|succeeded|finished)$/i;
const FAILED_RE = /^(error|failed|failure|cancelled)$/i;

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 70_000): Promise<{ status: number; data: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// إنشاء مهمة دمج — 200/201: {jobId, status, statusUrl, processUrl, expiresAt}
export async function createMergeJob(urls: string[]): Promise<{ jobId: string; expiresAt?: string }> {
  if (!mergerConfigured()) throw new Error("MERGER_API_BASE غير مضبوط — خدمة الدمج غير متاحة");
  const { status, data } = await fetchJson(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: urls }),
  });
  if (status >= 400 || !data.jobId) {
    throw new Error(String(data.error || `فشل إنشاء مهمة الدمج (HTTP ${status})`));
  }
  return { jobId: String(data.jobId), expiresAt: data.expiresAt as string | undefined };
}

// تنفيذ الدمج — يستغرق ~10–15 ثانية (blocking). يُستدعى مرة واحدة فقط لكل مهمة.
export async function runMergeProcess(jobId: string): Promise<void> {
  // لا ننتظر النتيجة هنا — التحديث يُقرأ من GET /api/jobs/{id} لاحقًا؛
  // إن فشل التنفيذ فستعلن الخدمة ذلك في الاستعلام (status=failed + error).
  await fetchJson(`${BASE}/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, 75_000).catch(() => {});
}

// استعلام حالة مهمة — تحليل دفاعي: قد يرد الجسم فيه error بدون حقل status
export async function getMergeJob(jobId: string): Promise<MergerJob> {
  if (!mergerConfigured()) throw new Error("MERGER_API_BASE غير مضبوط — خدمة الدمج غير متاحة");
  const { status, data } = await fetchJson(`${BASE}/api/jobs/${encodeURIComponent(jobId)}`, {}, 20_000);
  if (status === 404) throw new Error("NOT_FOUND_404");
  if (status >= 400 || data.error) {
    // جسم فيه error بدون status → عاملها failed فورًا
    return {
      jobId,
      status: "failed",
      progress: 0,
      error: String(data.error || `HTTP ${status} من خدمة الدمج`),
    };
  }
  const raw = String(data.status ?? "").toLowerCase();
  let st: MergerJob["status"];
  if (DONE_RE.test(raw)) st = "done";
  else if (FAILED_RE.test(raw)) st = "failed";
  else if (raw === "processing" || raw === "in_progress" || raw === "running") st = "processing";
  else st = "queued";

  // progress يأتي أحيانًا كسرًا 0..1 → اضربه في 100
  let progress = Number(data.progress ?? 0);
  if (progress > 0 && progress <= 1) progress *= 100;
  if (st === "done") progress = 100;

  // رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط رابط الفيديو المباشر
  const videoUrl = (data.videoUrl as string) || (data.downloadUrl as string) || `${BASE}/api/jobs/${jobId}/video`;
  return {
    jobId,
    status: st,
    progress: Math.round(Math.min(Math.max(progress, 0), 100)),
    videoUrl,
    downloadUrl: (data.downloadUrl as string) || `${data.videoUrl ? `${data.videoUrl}?download=1` : `${videoUrl}?download=1`}`,
    error: (data.error as string) || undefined,
    size: data.size !== undefined ? Number(data.size) : undefined,
    duration: data.duration !== undefined ? Number(data.duration) : undefined,
    resolution: data.resolution as string | undefined,
    expiresAt: data.expiresAt as string | undefined,
  };
}

export async function deleteMergeJob(jobId: string): Promise<void> {
  if (!mergerConfigured()) return;
  await fetchJson(`${BASE}/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, 15_000).catch(() => {});
}

// فحص جهوزية الخدمة: GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ
export async function mergerHealthy(): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const { status } = await fetchJson(`${BASE}/api/config`, {}, 4_000);
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}

export function mergerBase(): string {
  return BASE || "(غير مضبوط)";
}
