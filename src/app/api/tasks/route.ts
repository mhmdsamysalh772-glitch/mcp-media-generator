// GET /api/tasks — أحدث المهام + الإحصائيات (للوحة المهام التي تتحدث كل 5 ثوانٍ)
import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  await ensureSchema();
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 20), 1), 50);
  const type = searchParams.get("type") || undefined;
  const status = searchParams.get("status") || undefined;
  const [tasks, stats] = await Promise.all([
    listRecentTasks(limit, { type: type || undefined, status: status || undefined }),
    taskStats(),
  ]);
  return NextResponse.json(
    {
      stats,
      tasks: tasks.map((t) => {
        let urls: string[] = [];
        let attempts: unknown[] = [];
        try { urls = JSON.parse(t.result_urls_json || "[]"); } catch { /* بلا روابط */ }
        try { attempts = JSON.parse(t.attempts_json || "[]"); } catch { /* بلا محاولات */ }
        return {
          id: t.id,
          type: t.type,
          model: t.model,
          provider: t.provider,
          status: t.status,
          progress: t.progress,
          prompt: t.prompt,
          urls,
          error: t.error_message,
          attemptsCount: attempts.length,
          createdAt: t.created_at,
          completedAt: t.completed_at,
        };
      }),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
