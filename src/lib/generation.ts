// منسّق التوليد runGeneration + الدمج runMerge + التحديث الحي refreshTask
// القواعد الذهبية المطبقة هنا:
// 1) روابط فقط — لا تنزيل أي وسائط إلى السيرفر.
// 2) تجربة المفاتيح تسلسلية صارمة بترتيب الإضافة.
// 3) لا توقف عند نفاد الرصيد — انتقال للمفتاح التالي واستئناف نفس المهمة بنفس task_id.
// 4) نموذج الذكاء الاصطناعي لا يرى أخطاء مفاتيح/رصيد أبدًا.
// 5) مهمة فشلت على كل المفاتيح تبقى processing وتُعاد مع كل get_task (تهدئة 45 ثانية).
import { randomUUID } from "crypto";
import {
  classifyProviderError,
  isKeyOrBalanceClass,
  messageIndicatesKeyProblem,
  ProviderError,
} from "./errors";
import { getKeyPool, bumpKeyCounters, markKeyStatus, maskKey } from "./keys";
import { getAdapter } from "./providers";
import { MODELS, type ModelDef, type MediaType } from "./models";
import {
  ensureSchema,
  getTask,
  insertTask,
  parseDbDate,
  updateTask,
  type Attempt,
  type TaskRow,
} from "./turso";
import { createMergeJob, getMergeJob, mergerConfigured, runMergeProcess } from "./merger";

// أقصى نافذة انتظار داخل استدعاء الأداة — حد أمان لمدة دوال Vercel (Hobby=60 ثانية)
const MAX_WAIT = Math.min(Number(process.env.MAX_WAIT_SECONDS || 50), 240);

export interface ProgressNotifier {
  (progress: number, total: number, message: string): Promise<void> | void;
}

export type Outcome =
  | { kind: "no_keys"; message: string }
  | { kind: "completed"; taskId: string; urls: string[]; message: string; type: MediaType }
  | { kind: "processing"; taskId: string; message: string; type: MediaType }
  | { kind: "failed"; message: string };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// قفل في الذاكرة لتنفيذ process مرة واحدة فقط لكل مهمة دمج (حتى لا يتزامن مع get_task)
const processInFlight = new Set<string>();

function attemptFor(a: {
  provider: string; keyId?: string; keyLabel?: string; ok: boolean; errorClass?: string; error?: string;
}): Attempt {
  return {
    provider: a.provider,
    keyId: a.keyId ?? "",
    keyLabel: a.keyLabel,
    ok: a.ok,
    errorClass: a.errorClass,
    error: a.error,
    at: new Date().toISOString(),
  };
}

// ===== 1) الإنشاء على المرشحين بالترتيب التسلسلي =====
// يعيد: مرشح ناجح (مزود + مفتاح + معرّف مزود) أو روابط فورية (صور متزامنة) أو فشل حقيقي (params)
type CreationResult =
  | { kind: "created"; provider: string; keyId: string; apiKey: string; providerTaskId: string }
  | { kind: "sync_urls"; provider: string; keyId: string; apiKey: string; urls: string[] }
  | { kind: "out_of_keys" }
  | { kind: "real_failure"; message: string };

async function createOnNextKey(
  taskId: string,
  model: ModelDef,
  type: MediaType,
  params: Record<string, unknown>,
  pool: Awaited<ReturnType<typeof getKeyPool>>,
  startIndex: number
): Promise<CreationResult> {
  for (let i = startIndex; i < pool.length; i++) {
    const key = pool[i];
    const adapter = getAdapter(key.provider as "kie" | "cometapi");
    const providerModel = model.providerModel[key.provider as "kie" | "cometapi"];
    const keyLabel = key.label || maskKey(key.api_key);
    try {
      // صور متزامنة إن كان المزود يدعمها (CometAPI) — النتيجة فورية
      if (type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key.api_key, {
          model: providerModel,
          prompt: params.prompt,
          size: params.size,
          output_format: params.output_format,
          background: params.background,
        });
        await bumpKeyCounters(key.id, { ok: true });
        await updateTask(taskId, {
          provider: key.provider,
          key_id: key.id,
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify(urls),
          attempt: attemptFor({ provider: key.provider, keyId: key.id, keyLabel, ok: true }),
        });
        return { kind: "sync_urls", provider: key.provider, keyId: key.id, apiKey: key.api_key, urls };
      }
      const handle = await adapter.createTask(key.api_key, providerModel, params);
      await bumpKeyCounters(key.id, { ok: true });
      await updateTask(taskId, {
        provider: key.provider,
        provider_task_id: handle.providerTaskId,
        key_id: key.id,
        attempt: attemptFor({ provider: key.provider, keyId: key.id, keyLabel, ok: true }),
      });
      return { kind: "created", provider: key.provider, keyId: key.id, apiKey: key.api_key, providerTaskId: handle.providerTaskId };
    } catch (e) {
      const err = e as ProviderError;
      const cls = err instanceof ProviderError ? classifyProviderError(err.status, err.message) : classifyProviderError(undefined, String(err));
      const errText = String(err?.message || "خطأ غير معروف").slice(0, 300);
      // عدّادات المفتاح تُحدَّث دائمًا
      await bumpKeyCounters(key.id, { ok: false, error: errText, lastChecked: true });
      await updateTask(taskId, {
        attempt: attemptFor({ provider: key.provider, keyId: key.id, keyLabel, ok: false, errorClass: cls, error: errText }),
      });
      if (cls === "disabled") {
        await markKeyStatus(key.id, "disabled", errText);
        continue; // مفتاح مرفوض → التالي
      }
      if (cls === "exhausted") {
        await markKeyStatus(key.id, "exhausted", errText);
        continue; // مستنزف (يبقى في القاعدة) → التالي
      }
      if (cls === "provider") continue; // موديل غير مدعوم هنا → المزود التالي
      if (cls === "params") {
        // خطأ معطيات — تبديل المفاتيح لن يحلّه → توقف فورًا (فشل حقيقي مسموح إظهاره)
        const msg = "❌ فشلت المهمة: المعطيات المرسلة للمزود غير مقبولة — " + errText;
        await updateTask(taskId, { status: "failed", error_message: msg, progress: 0 });
        return { kind: "real_failure", message: msg };
      }
      continue; // temporary → الانتقال الآن
    }
  }
  return { kind: "out_of_keys" };
}

// ===== 2) نافذة الانتظار مع بث التقدم =====
async function pollUntilDone(opts: {
  taskId: string;
  task: TaskRow;
  model: ModelDef;
  pool: Awaited<ReturnType<typeof getKeyPool>>;
  startedAtIndex: number;
  waitSeconds: number;
  notify?: ProgressNotifier;
}): Promise<Outcome> {
  const { taskId, model, pool, waitSeconds, notify } = opts;
  let task = opts.task;
  let idx = opts.startedAtIndex; // المرشح التالي عند التبديل في منتصف المهمة

  const deadline = Date.now() + Math.min(waitSeconds, MAX_WAIT) * 1000;
  let lastNotify = 0;

  while (Date.now() < deadline) {
    task = (await getTask(taskId))!;
    if (task.status === "completed") {
      return finalizeCompleted(task);
    }
    if (task.status === "failed") {
      return { kind: "failed", message: task.error_message || "فشلت المهمة" };
    }
    if (task.type === "merge") {
      // لا يمر من هنا — الدمج له مساره الخاص
      break;
    }
    if (!task.provider_task_id || !task.key_id) {
      // لم يُنشأ بعد على أي مفتاح → أعد المحاولة فورًا على المرشحين المتبقين
      const cr = await createOnNextKey(taskId, model, task.type as MediaType, safeParams(task), pool, idx);
      if (cr.kind === "created") {
        idx = pool.findIndex((k) => k.id === cr.keyId) + 1;
      } else if (cr.kind === "sync_urls") {
        task = (await getTask(taskId))!;
        return finalizeCompleted(task);
      } else if (cr.kind === "real_failure") {
        return { kind: "failed", message: cr.message };
      } else {
        // كل المفاتيح فشلت → تبقى processing بانتظار شحن رصيد/إضافة مفتاح
        await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
        return processingOutcome(taskId, task.type as MediaType);
      }
    } else {
      // استعلام الحالة من المزود
      const keyRow = pool.find((k) => k.id === task.key_id);
      const provider = (task.provider || keyRow?.provider) as "kie" | "cometapi";
      try {
        const adapter = getAdapter(provider);
        const check = await adapter.checkTask(keyRow ? keyRow.api_key : "", task.provider_task_id!);
        if (check.status === "completed") {
          await updateTask(taskId, {
            status: "completed",
            progress: 100,
            result_urls_json: JSON.stringify(check.urls || []),
          });
          task = (await getTask(taskId))!;
          return finalizeCompleted(task);
        }
        if (check.status === "failed") {
          const msg = check.error || "";
          // فشل منتصف المهمة يطابق مشكلات مفتاح/رصيد → أعد الإنشاء على المفتاح التالي بنفس task_id
          if (isKeyOrBalanceClass(classifyProviderError(undefined, msg)) || messageIndicatesKeyProblem(msg)) {
            await updateTask(taskId, {
              provider: null,
              provider_task_id: null,
              key_id: null,
              progress: 0,
              attempt: attemptFor({ provider, keyId: task.key_id || "", ok: false, errorClass: "mid-task", error: msg }),
            });
            const cr = await createOnNextKey(taskId, model, task.type as MediaType, safeParams(task), pool, idx);
            if (cr.kind === "created") {
              idx = pool.findIndex((k) => k.id === cr.keyId) + 1;
            } else if (cr.kind === "real_failure") {
              return { kind: "failed", message: cr.message };
            } else {
              await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
              return processingOutcome(taskId, task.type as MediaType);
            }
          } else {
            // فشل حقيقي (انتهاك سياسة/معطيات) → فشل نهائي
            const final = "❌ فشلت المهمة: " + (msg || "سبب غير معروف من المزود");
            await updateTask(taskId, { status: "failed", error_message: final });
            return { kind: "failed", message: final };
          }
        }
        // جارية → حدّث التقدم
        await updateTask(taskId, { progress: check.progress ?? task.progress ?? 0, status: "processing" });
      } catch (e) {
        // أخطاء شبكتنا/استعلام → مؤقتة: استمر بالاستعلام حتى انتهاء النافذة
        const cls = classifyProviderError((e as ProviderError).status, (e as Error).message);
        if (isKeyOrBalanceClass(cls)) {
          // مفتاح صار مرفوضًا أثناء الاستعلام → تبديل صامت إلى المفتاح التالي
          await updateTask(taskId, {
            provider: null,
            provider_task_id: null,
            key_id: null,
            progress: 0,
            attempt: attemptFor({ provider, keyId: task.key_id || "", ok: false, errorClass: cls, error: String((e as Error).message) }),
          });
          const cr = await createOnNextKey(taskId, model, task.type as MediaType, safeParams(task), pool, idx);
          if (cr.kind === "created") idx = pool.findIndex((k) => k.id === cr.keyId) + 1;
          else if (cr.kind === "real_failure") return { kind: "failed", message: cr.message };
          else {
            await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
            return processingOutcome(taskId, task.type as MediaType);
          }
        }
        // غير ذلك: تجاهل واستمر بالاستعلام
      }
    }

    // بث تقدم كل ~3 ثوانٍ (إن زوّد العميل progressToken)
    const current = (await getTask(taskId))!;
    const p = Math.min(current.progress ?? 0, 95);
    const now = Date.now();
    if (notify && now - lastNotify >= 2800) {
      lastNotify = now;
      await notify(p, 100, `قيد التوليد… ${p}%`);
    }
    await sleep(3000);
  }

  // انتهت النافذة والنتيجة لم تظهر → أعِد المهمة بحالة processing والعميل يتابع بـ get_task
  return processingOutcome(taskId, (await getTask(taskId))!.type as MediaType);
}

function safeParams(t: TaskRow): Record<string, unknown> {
  try { return JSON.parse(t.params_json || "{}"); } catch { return {}; }
}

function processingOutcome(taskId: string, type: MediaType): Outcome {
  return {
    kind: "processing",
    taskId,
    type,
    message: `⏳ المهمة قيد المعالجة — task_id: ${taskId}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
  };
}

// صياغة الرد العربي للمهام المكتملة (حسب المواصفة)
function finalizeCompleted(task: TaskRow): Outcome {
  let urls: string[] = [];
  try { urls = JSON.parse(task.result_urls_json || "[]"); } catch { /* بلا روابط */ }
  const type = task.type as MediaType;
  let message: string;
  if (type === "image") {
    const u = urls[0] || "";
    message = `✅ تم توليد الصورة بنجاح\n\n![image](${u})\n\nالرابط المباشر: ${u}`;
  } else if (type === "merge") {
    const list = urls.map((u) => `- ${u}`).join("\n");
    message = `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر: ${urls[0] || ""}\n${urls.length > 1 ? list + "\n" : ""}\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
  } else {
    const list = urls.map((u) => `- الرابط المباشر: ${u}`).join("\n");
    message = `✅ تم توليد الفيديو بنجاح\n\n${list}`;
  }
  return { kind: "completed", taskId: task.id, urls, message, type };
}

// ===== runGeneration — التدفق الكامل لأداة generate_image / generate_video =====
export async function runGeneration(opts: {
  model: ModelDef;
  type: MediaType;
  prompt: string;
  params: Record<string, unknown>;
  waitSeconds: number;
  notify?: ProgressNotifier;
}): Promise<Outcome> {
  await ensureSchema();
  const { model, type, prompt, params, waitSeconds, notify } = opts;

  // 1) بركة المفاتيح بالترتيب التسلسلي الصارم
  const pool = await getKeyPool(model.providers);
  if (!pool.length) {
    return {
      kind: "no_keys",
      message: `❌ لا توجد مفاتيح نشطة لخدمة ${model.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    };
  }

  // 2) سجّل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: model.canonical,
    type,
    prompt,
    params_json: JSON.stringify(params),
    status: "processing",
  });

  // 3) جرّب المرشحين بالترتيب حتى نجاح الإنشاء
  const cr = await createOnNextKey(taskId, model, type, params, pool, 0);
  if (cr.kind === "real_failure") return { kind: "failed", message: cr.message };
  if (cr.kind === "sync_urls") {
    const task = (await getTask(taskId))!;
    return finalizeCompleted(task);
  }
  if (cr.kind === "out_of_keys") {
    // فشل الإنشاء على كل المفاتيح → تبقى processing (وليست failed) وتُعاد مع كل get_task
    await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
    return processingOutcome(taskId, type);
  }

  // 4) نافذة الانتظار مع بث التقدم
  const task = (await getTask(taskId))!;
  const idx = pool.findIndex((k) => k.id === cr.keyId) + 1;
  return pollUntilDone({ taskId, task, model, pool, startedAtIndex: idx, waitSeconds, notify });
}

// ===== runMerge — تدفق أداة merge_videos =====
export async function runMerge(opts: {
  urls?: string[];
  taskIds?: string[];
  waitSeconds: number;
  notify?: ProgressNotifier;
}): Promise<Outcome> {
  await ensureSchema();
  const { urls = [], taskIds = [], waitSeconds, notify } = opts;

  // حل روابط task_ids (لمهام فيديو مكتملة) بالترتيب
  const resolvedUrls: string[] = [];
  const failedDetails: string[] = [];
  for (const tid of taskIds) {
    const t = await getTask(tid.trim());
    let reason = "";
    if (!t) reason = "غير موجود في قاعدة البيانات";
    else if (t.type !== "video") reason = `نوعه ${t.type} وليس video`;
    else if (t.status !== "completed") reason = `حالته ${t.status} وليست completed`;
    else {
      let u: string[] = [];
      try { u = JSON.parse(t.result_urls_json || "[]"); } catch { /* بلا روابط */ }
      if (!u.length) reason = "لا روابط نتائج محفوظة";
      else resolvedUrls.push(u[0]);
    }
    if (reason) failedDetails.push(`- ${tid}: ${reason}`);
  }

  const combined = [...resolvedUrls, ...urls.map((u) => u.trim())];

  // تحقق صارم قبل أي نداء خارجي
  if (combined.length < 2) {
    const details = failedDetails.length ? `\n\nتفاصيل المعرفات غير القابلة للدمج:\n${failedDetails.join("\n")}` : "";
    return {
      kind: "failed",
      message: `❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.${details}`,
    };
  }
  if (combined.length > 10) {
    return {
      kind: "failed",
      message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
    };
  }
  if (!combined.every((u) => /^https?:\/\//i.test(u))) {
    return {
      kind: "failed",
      message: "❌ كل المقاطع يجب أن تكون روابط مباشرة عامة (http/https).",
    };
  }
  if (!mergerConfigured()) {
    return {
      kind: "failed",
      message: "❌ خدمة الدمج غير مهيأة — اضبط متغير البيئة MERGER_API_BASE.",
    };
  }

  // سجّل مهمة الدمج في Turso أولًا
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${combined.length} مقاطع`,
    params_json: JSON.stringify({ urls: combined, task_ids: taskIds }),
    status: "processing",
  });

  try {
    const { jobId } = await createMergeJob(combined);
    await updateTask(taskId, {
      provider: "merger",
      provider_task_id: jobId,
      attempt: attemptFor({ provider: "merger", keyId: "", keyLabel: "merger", ok: true }),
    });

    // أطلق process خلفيًا وبمرة واحدة فقط (قفل في الذاكرة حتى لا يتزامن مع get_task)
    void fireProcessOnce(jobId);

    // نافذة الانتظار: استعلم كل 3 ثوانٍ مع بث تقدم
    const deadline = Date.now() + Math.min(waitSeconds, MAX_WAIT) * 1000;
    let lastNotify = 0;
    while (Date.now() < deadline) {
      await sleep(3000);
      let job;
      try {
        job = await getMergeJob(jobId);
      } catch (e) {
        const msg = String((e as Error).message || "");
        if (msg === "NOT_FOUND_404") {
          const final = "❌ فشلت المهمة: مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)";
          await updateTask(taskId, { status: "failed", error_message: final });
          return { kind: "failed", message: final };
        }
        // أخطاء شبكتنا → مؤقتة: استمر بالاستعلام حتى انتهاء النافذة
        continue;
      }
      if (job.status === "done") {
        await updateTask(taskId, {
          status: "completed",
          progress: 100,
          result_urls_json: JSON.stringify([job.videoUrl || `job:${jobId}`]),
        });
        const task = (await getTask(taskId))!;
        return finalizeCompleted(task);
      }
      if (job.status === "failed") {
        // أي خطأ HTTP معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
        const final = "❌ فشلت المهمة: فشل الدمج — " + (job.error || "سبب غير معروف من الخدمة");
        await updateTask(taskId, { status: "failed", error_message: final });
        return { kind: "failed", message: final };
      }
      // تحديث الحالة في Turso فورًا كل مرة
      await updateTask(taskId, { status: "processing", progress: Math.min(job.progress, 95) });
      const now = Date.now();
      if (notify && now - lastNotify >= 2800) {
        lastNotify = now;
        await notify(Math.min(job.progress, 95), 100, `قيد الدمج… ${Math.min(job.progress, 95)}%`);
      }
    }
    // انتهت النافذة والنتيجة لم تظهر → أعِد المهمة بحالة processing والعميل يتابع بـ get_task
    return processingOutcome(taskId, "merge");
  } catch (e) {
    const msg = String((e as Error).message || "");
    const final = "❌ فشلت المهمة: " + msg;
    await updateTask(taskId, { status: "failed", error_message: final });
    return { kind: "failed", message: final };
  }
}

// تنفيذ process مرة واحدة لكل jobId — القفل يمنع التزامن مع get_task
async function fireProcessOnce(jobId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  try {
    await runMergeProcess(jobId);
  } finally {
    // نبقي القفل بعد النجاح (الخدمة تسجل التنفيذ مرة واحدة) ونحذفه عند الفشل الشبكي فقط
    processInFlight.delete(jobId);
  }
}

// ===== refreshTask — تحديث حي عند كل get_task =====
export async function refreshTask(taskId: string, notify?: ProgressNotifier): Promise<Outcome> {
  await ensureSchema();
  const t = await getTask(taskId);
  if (!t) {
    return { kind: "failed", message: `❌ فشلت المهمة: لم يتم العثور على مهمة بالمعرّف ${taskId}` };
  }
  if (t.status === "completed") return finalizeCompleted(t);
  if (t.status === "failed") return { kind: "failed", message: t.error_message || "فشلت المهمة" };

  if (t.type === "merge") return refreshMergeTask(t);

  // مهام التوليد
  const model = resolveModelForRefresh(t.model, t.type as MediaType);
  const pool = await getKeyPool(model.providers);

  if (!t.provider_task_id || !t.key_id) {
    // لم تُنشأ بعد — أعد المحاولة تلقائيًا مع كل get_task بعد تهدئة ~45 ثانية حتى لا نضغط المزودين
    const updated = parseDbDate(t.updated_at);
    if (updated && Date.now() - updated.getTime() < 45_000) {
      return processingOutcome(taskId, t.type as MediaType);
    }
    const cr = await createOnNextKey(taskId, model!, t.type as MediaType, safeParams(t), pool, 0);
    if (cr.kind === "created") {
      // فحص فوري واحد ثم أعِد الحالة
      const idx = pool.findIndex((k) => k.id === cr.keyId) + 1;
      return pollOnce({ taskId, task: (await getTask(taskId))!, model: model!, pool, startedAtIndex: idx });
    }
    if (cr.kind === "sync_urls") return finalizeCompleted((await getTask(taskId))!);
    if (cr.kind === "real_failure") return { kind: "failed", message: cr.message };
    await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
    return processingOutcome(taskId, t.type as MediaType);
  }

  // جارية عند مزود — حدّث حيًا
  const keyRow = pool.find((k) => k.id === t.key_id) || null;
  const provider = (t.provider || keyRow?.provider) as "kie" | "cometapi";
  try {
    const adapter = getAdapter(provider);
    const check = await adapter.checkTask(keyRow ? keyRow.api_key : "", t.provider_task_id);
    if (check.status === "completed") {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify(check.urls || []) });
      return finalizeCompleted((await getTask(taskId))!);
    }
    if (check.status === "failed") {
      const msg = check.error || "";
      if (isKeyOrBalanceClass(classifyProviderError(undefined, msg)) || messageIndicatesKeyProblem(msg)) {
        // تبديل صامت: أعد الإنشاء على المفتاح التالي بنفس task_id — العميل يرى processing فقط
        await updateTask(taskId, { provider: null, provider_task_id: null, key_id: null, progress: 0 });
        const cr = await createOnNextKey(taskId, model!, t.type as MediaType, safeParams(t), pool, pool.findIndex((k) => k.id === t.key_id) + 1);
        if (cr.kind === "created") return processingOutcome(taskId, t.type as MediaType);
        if (cr.kind === "sync_urls") return finalizeCompleted((await getTask(taskId))!);
        if (cr.kind === "real_failure") return { kind: "failed", message: cr.message };
        await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
        return processingOutcome(taskId, t.type as MediaType);
      }
      const final = "❌ فشلت المهمة: " + (msg || "سبب غير معروف من المزود");
      await updateTask(taskId, { status: "failed", error_message: final });
      return { kind: "failed", message: final };
    }
    await updateTask(taskId, { status: "processing", progress: check.progress ?? t.progress ?? 0 });
    return processingOutcome(taskId, t.type as MediaType);
  } catch (e) {
    const cls = classifyProviderError((e as ProviderError).status, (e as Error).message);
    if (isKeyOrBalanceClass(cls)) {
      await updateTask(taskId, { provider: null, provider_task_id: null, key_id: null, progress: 0 });
      const cr = await createOnNextKey(taskId, model!, t.type as MediaType, safeParams(t), pool, pool.findIndex((k) => k.id === t.key_id) + 1);
      if (cr.kind === "created") return processingOutcome(taskId, t.type as MediaType);
      if (cr.kind === "sync_urls") return finalizeCompleted((await getTask(taskId))!);
      if (cr.kind === "real_failure") return { kind: "failed", message: cr.message };
      await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
      return processingOutcome(taskId, t.type as MediaType);
    }
    // شبكة مؤقتة — أعِد الحالة الحالية دون تغيير
    return processingOutcome(taskId, t.type as MediaType);
  }
}

// فحص واحد سريع بعد إعادة الإنشاء داخل refreshTask
async function pollOnce(opts: { taskId: string; task: TaskRow; model: ModelDef; pool: Awaited<ReturnType<typeof getKeyPool>>; startedAtIndex: number }): Promise<Outcome> {
  const { taskId, task } = opts;
  try {
    const keyRow = opts.pool.find((k) => k.id === task.key_id);
    const provider = (task.provider || keyRow?.provider) as "kie" | "cometapi";
    const adapter = getAdapter(provider);
    const check = await adapter.checkTask(keyRow ? keyRow.api_key : "", task.provider_task_id!);
    if (check.status === "completed") {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify(check.urls || []) });
      return finalizeCompleted((await getTask(taskId))!);
    }
    if (check.status === "failed") {
      const msg = check.error || "";
      if (messageIndicatesKeyProblem(msg)) {
        return processingOutcome(taskId, task.type as MediaType); // سيُعاد التبديل في الاستدعاء التالي
      }
      const final = "❌ فشلت المهمة: " + msg;
      await updateTask(taskId, { status: "failed", error_message: final });
      return { kind: "failed", message: final };
    }
    await updateTask(taskId, { progress: check.progress ?? 0 });
  } catch { /* استعلام فاشل — ابقَ processing */ }
  return processingOutcome(taskId, task.type as MediaType);
}

// استعادة تعريف الموديل من canonical المخزن — وإن تغيّرت أسماء البيئة نبني تعريفًا احتياطيًا بنفس الاسم
function resolveModelForRefresh(canonical: string, type: MediaType): ModelDef {
  return (
    MODELS.find((m) => m.canonical === canonical) || {
      canonical,
      aliases: [canonical],
      type,
      providers: ["kie", "cometapi"],
      providerModel: { kie: canonical, cometapi: canonical },
    }
  );
}

// ===== refreshMergeTask — تحديث مهمة دمج من خدمة الدمج =====
async function refreshMergeTask(t: TaskRow): Promise<Outcome> {
  const taskId = t.id;
  if (!t.provider_task_id) {
    return processingOutcome(taskId, "merge");
  }
  try {
    const job = await getMergeJob(t.provider_task_id);
    if (job.status === "done") {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls_json: JSON.stringify([job.videoUrl || `job:${t.provider_task_id}`]) });
      return finalizeCompleted((await getTask(taskId))!);
    }
    if (job.status === "failed") {
      const final = "❌ فشلت المهمة: فشل الدمج — " + (job.error || "سبب غير معروف من الخدمة");
      await updateTask(taskId, { status: "failed", error_message: final });
      return { kind: "failed", message: final };
    }
    if (job.status === "queued") {
      // لم يُنفَّذ process بعد → نفّذه الآن (القفل يمنع التكرار)
      void fireProcessOnce(t.provider_task_id);
      return processingOutcome(taskId, "merge");
    }
    await updateTask(taskId, { status: "processing", progress: job.progress });
    return processingOutcome(taskId, "merge");
  } catch (e) {
    const msg = String((e as Error).message || "");
    if (msg === "NOT_FOUND_404") {
      // ردت الخدمة 404 → فشل نهائي
      const final = "❌ فشلت المهمة: مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)";
      await updateTask(taskId, { status: "failed", error_message: final });
      return { kind: "failed", message: final };
    }
    // شبكتنا → مؤقتة: ابقَ processing
    return processingOutcome(taskId, "merge");
  }
}
