// مسار خادم MCP — Streamable HTTP وفق مواصفات MCP عبر SDK الرسمي.
// وضع عديم الجلسة (stateless): نسخة نقل جديدة لكل طلب — ضروري لبيئة Vercel serverless
// لأن الجلسات لا تبقى في الذاكرة بين الاستدعاءات.
import type { NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // حد أمان خطة Hobby على Vercel (الموديلات الأطول تتابع بـ get_task)

// حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Bearer token على /mcp
function authOk(request: NextRequest): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${token}`;
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized: Bearer token required on /mcp (MCP_ACCESS_TOKEN)" },
    }),
    { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } }
  );
}

// GET (بث مستقل للسيرفر) و DELETE (إنهاء جلسة) غير مدعومين في الوضع العديم الجلسة —
// 405 متوافق مع المواصفة ويمنع بثًا لانهائيًا على serverless.
function methodNotAllowed(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method Not Allowed: stateless MCP server accepts POST requests only on /mcp" },
    }),
    { status: 405, headers: { "Content-Type": "application/json", Allow: "POST" } }
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!authOk(request)) return unauthorized();

  // نسخة جديدة لكل طلب (شرط SDK في الوضع العديم الجلسة)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableDnsRebindingProtection: false,
  });
  const server = buildMcpServer();
  await server.connect(transport);

  try {
    // الجسم يُحلل مسبقًا ويُمرر للنقل — أخطاء التحليل ترد بـ -32700 وفق JSON-RPC
    const text = await request.text();
    let parsedBody: unknown;
    try {
      parsedBody = text ? JSON.parse(text) : undefined;
    } catch {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: invalid JSON body" } }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    // النقل القياسي يعيد Web Response مباشرة — بما فيه بث SSE للتقدم أثناء التوليد
    return await transport.handleRequest(request, { parsedBody });
  } catch (e) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal error: " + String((e as Error)?.message || e) },
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}
