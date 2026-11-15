// خادم MCP — الأدوات الخمس + تعليمات السيرفر. الأوصاف إنجليزية حرفية (العميل يقرأها)،
// ونتائج الاستدعاء تُصاغ بالعربية (المصطلحات التقنية وأسماء الأدوات تبقى بالإنجليزية).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MODELS, resolveModel, type MediaType } from "./models";
import { listRecentTasks, taskStats, type TaskRow } from "./turso";
import { runGeneration, runMerge, refreshTask, type Outcome } from "./generation";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

// نص التعليمات المرسل مع initialize — حرفيًا كما في المواصفة
export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// نافذة الانتظار الافتراضية (الصور 90 / الفيديو 25 / الدمج 60 — تُقتطع بحد أمان MAX_WAIT_SECONDS داخل المنسّق)
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function toOutcome(o: Outcome): ToolResult {
  if (o.kind === "no_keys" || o.kind === "failed") {
    return { content: [{ type: "text", text: o.message }], isError: true };
  }
  return { content: [{ type: "text", text: o.message }] };
}

function errorMessage(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// استخراج progressToken من _meta إن زوّده العميل — وإلا فلا بث
function notifierFrom(extra: unknown) {
  const ex = extra as { _meta?: { progressToken?: string | number }; sendNotification: (n: unknown) => Promise<void> } | undefined;
  const token = ex?._meta?.progressToken;
  if (!token || !ex?.sendNotification) return undefined;
  return async (progress: number, total: number, message: string) => {
    await ex.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, total, message },
    });
  };
}

// صياغة list_media بالعربية
function formatMediaRow(t: TaskRow): string {
  let urls: string[] = [];
  try { urls = JSON.parse(t.result_urls_json || "[]"); } catch { /* بلا روابط */ }
  const icon = t.type === "image" ? "🖼️" : t.type === "video" ? "🎬" : "🔗";
  const statusIcon = t.status === "completed" ? "✅" : t.status === "failed" ? "❌" : "⏳";
  const lines = [
    `${statusIcon} ${icon} ${t.type} — ${t.model}`,
    `  task_id: ${t.id} | الحالة: ${t.status} | التقدم: ${t.progress}%`,
    t.prompt ? `  الوصف: ${t.prompt.slice(0, 120)}` : "",
  ];
  if (urls.length) lines.push(...urls.map((u) => `  - ${u}`));
  if (t.status === "failed" && t.error_message) lines.push(`  الخطأ: ${t.error_message.slice(0, 200)}`);
  lines.push(`  أُنشئت: ${t.created_at}`);
  return lines.filter(Boolean).join("\n");
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // 1) generate_image
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active keys). Returns the ready image URL if finished within the wait window, otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z.enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"]).default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z.enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"]).default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const model = resolveModel(args.model);
      if (!model || model.type !== "image") return errorMessage(`❌ فشلت المهمة: الموديل غير معروف — ${args.model}`);
      const { model: _m, ...rest } = args;
      void _m;
      const outcome = await runGeneration({
        model,
        type: "image",
        prompt: args.prompt,
        params: { ...rest },
        waitSeconds: rest.wait_seconds ?? 90,
        notify: notifierFrom(extra),
      });
      return toOutcome(outcome);
    }
  );

  // 2) generate_video
  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). Videos take minutes: a short wait with live progress is streamed, then a task_id is returned — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z.enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"]).default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const model = resolveModel(args.model);
      if (!model || model.type !== "video") return errorMessage(`❌ فشلت المهمة: الموديل غير معروف — ${args.model}`);
      const { model: _m, ...rest } = args;
      void _m;
      const outcome = await runGeneration({
        model,
        type: "video",
        prompt: args.prompt,
        params: { ...rest },
        waitSeconds: rest.wait_seconds ?? 25,
        notify: notifierFrom(extra),
      });
      return toOutcome(outcome);
    }
  );

  // 3) merge_videos
  server.registerTool(
    "merge_videos",
    {
      description:
        "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video links — like the ones from generate_video) or 'task_ids' (completed video generation tasks — their result URLs are merged in this order; ideal after generating several clips). Merging is usually quick: a short wait with live progress is streamed, then a merge task_id is returned — track it with get_task. IMPORTANT NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        // الحدان الإجماليان (≥2 و ≤10 بعد جمع المصفوفتين) يُفرضان في runMerge برسائل عربية
        urls: z.array(z.string()).min(1).optional().describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video. Maximum 10 clips total."),
        task_ids: z.array(z.string()).min(1).optional().describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order. Maximum 10 clips total."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const outcome = await runMerge({
        urls: args.urls,
        taskIds: args.task_ids,
        waitSeconds: args.wait_seconds ?? 60,
        notify: notifierFrom(extra),
      });
      return toOutcome(outcome);
    }
  );

  // 4) get_task
  server.registerTool(
    "get_task",
    {
      description:
        "Track any task by its id — image/video generation AND merging (reads the Turso database and updates live from the provider/merging service while in progress). Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args) => {
      const outcome = await refreshTask(args.task_id);
      return toOutcome(outcome);
    }
  );

  // 5) list_media
  server.registerTool(
    "list_media",
    {
      description:
        "List the latest images/videos/merges stored with their links from the database (no re-generation) — to recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const tasks = await listRecentTasks(args.limit ?? 10, { type: args.type, status: args.status });
      if (!tasks.length) {
        return { content: [{ type: "text", text: "لا توجد مهام مخزنة حتى الآن" + (args.type ? ` من النوع ${args.type}` : "") + "." }] };
      }
      const stats = await taskStats();
      const text =
        `أحدث الوسائط المخزنة (${tasks.length} من إجمالي ${stats.total}):\n\n` +
        tasks.map(formatMediaRow).join("\n\n");
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

// قائمة الموديلات المدعومة (تُستخدم في /api/health)
export function supportedModels() {
  return MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers }));
}

export type { MediaType };
