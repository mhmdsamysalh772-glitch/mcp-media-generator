// GET /api/health — فحص شامل: قاعدة البيانات + الموديلات + خدمة الدمج + حالة الحماية
import { NextResponse } from "next/server";
import { ensureSchema, getDb, dbHealthy } from "@/lib/turso";
import { supportedModels } from "@/lib/mcp-server";
import { mergerBase, mergerHealthy, mergerConfigured } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let database = "turso-error";
  let ok = false;
  try {
    await ensureSchema();
    ok = await dbHealthy();
    if (ok) database = "turso-connected";
  } catch {
    database = "turso-error";
  }

  const healthy = mergerConfigured() ? await mergerHealthy() : false;

  return NextResponse.json(
    {
      ok,
      database,
      mcpEndpoint: "/mcp",
      models: supportedModels(),
      merger: { base: mergerBase(), healthy },
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
