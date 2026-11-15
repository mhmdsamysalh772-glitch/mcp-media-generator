// PATCH /api/keys/{id} — تعطيل/تنشيط يدوي | DELETE /api/keys/{id} — حذف
import { NextRequest, NextResponse } from "next/server";
import { ensureSchema } from "@/lib/turso";
import { deleteKey, setKeyEnabled } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await ctx.params;
  const body = await request.json().catch(() => null) as { disabled?: boolean } | null;
  if (typeof body?.disabled !== "boolean") {
    return NextResponse.json({ error: "الحقل disabled (boolean) مطلوب" }, { status: 400 });
  }
  const ok = await setKeyEnabled(id, body.disabled);
  if (!ok) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await ctx.params;
  const ok = await deleteKey(id);
  if (!ok) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
