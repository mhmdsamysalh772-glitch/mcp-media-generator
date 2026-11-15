// GET /api/keys — قائمة المفاتيح مقنَّعة دائمًا | POST /api/keys — إضافة مفتاح مع رفض التكرار
import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/turso";
import { addKey, listKeys, maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSchema();
  const keys = await listKeys();
  // إخفاء المفتاح الكامل إلزامي — لا يُعاد في أي استجابة
  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      masked: maskKey(k.api_key),
      status: k.status,
      usageCount: k.usage_count,
      successCount: k.success_count,
      failCount: k.fail_count,
      lastUsedAt: k.last_used_at,
      lastError: k.last_error,
      createdAt: k.created_at,
    })),
  });
}

export async function POST(request: NextRequest) {
  await ensureSchema();
  const body = await request.json().catch(() => null) as { provider?: string; api_key?: string; label?: string } | null;
  if (!body?.provider || !body?.api_key) {
    return NextResponse.json({ error: "المزود والمفتاح مطلوبان" }, { status: 400 });
  }
  const res = await addKey(String(body.provider).trim().toLowerCase(), String(body.api_key).trim(), body.label?.trim() || undefined);
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, id: res.id }, { status: 201 });
}
