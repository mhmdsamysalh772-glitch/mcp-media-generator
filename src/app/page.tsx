"use client";

// لوحة الإدارة العربية RTL — صفحة واحدة بثلاث بطاقات:
// أ) مدير المفاتيح  ب) لوحة المهام (تحديث تلقائي كل 5 ثوانٍ)  ج) ربط السيرفر
import { useCallback, useEffect, useRef, useState } from "react";

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

interface KeyRow {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: "active" | "exhausted" | "disabled";
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

interface TaskRow {
  id: string;
  type: "image" | "video" | "merge";
  model: string;
  provider: string | null;
  status: "processing" | "completed" | "failed";
  progress: number;
  prompt: string;
  urls: string[];
  error: string | null;
  attemptsCount: number;
  createdAt: string;
}

const PROVIDER_LABEL: Record<string, string> = { kie: "kie.ai", cometapi: "CometAPI" };

function statusBadge(s: string) {
  const map: Record<string, string> = {
    active: "bg-emerald-400/15 text-emerald-300",
    completed: "bg-emerald-400/15 text-emerald-300",
    exhausted: "bg-amber-400/15 text-amber-300",
    processing: "bg-cyan-400/15 text-cyan-300",
    pending: "bg-cyan-400/15 text-cyan-300",
    disabled: "bg-slate-400/15 text-slate-300",
    failed: "bg-rose-400/15 text-rose-300",
  };
  const label: Record<string, string> = {
    active: "نشط", completed: "مكتملة", exhausted: "مستنزف",
    processing: "جارية", pending: "جارية", disabled: "معطل", failed: "فاشلة",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${map[s] || "bg-slate-400/15 text-slate-300"}`}>
      {label[s] || s}
    </span>
  );
}

function typeIcon(t: string) {
  return t === "image" ? "🖼️" : t === "video" ? "🎬" : "🔗";
}

const TOOLS = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي عبر gpt-image-2-6/flare" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن عبر grok-imagine (اختياري: صورة أول إطار)" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها — تحديث حي من المزود أو خدمة الدمج" },
  { name: "list_media", desc: "أحدث الوسائط المخزنة بروابطها لاسترجاع نتائج سابقة" },
];

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [mcpUrl, setMcpUrl] = useState("/mcp");
  const [copied, setCopied] = useState<string | null>(null);
  const tasksRef = useRef<HTMLDivElement>(null);

  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys");
      const j = await r.json();
      setKeys(j.keys || []);
    } catch { /* تجاهل — تحديث دوري */ }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20");
      const j = await r.json();
      setTasks(j.tasks || []);
      setStats(j.stats || stats);
    } catch { /* تجاهل — تحديث دوري */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health");
      setHealth(await r.json());
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadKeys();
    loadTasks();
    setMcpUrl(window.location.origin + "/mcp");
    const h = setInterval(loadHealth, 15000);
    const t = setInterval(loadTasks, 5000);
    return () => { clearInterval(h); clearInterval(t); };
  }, [loadHealth, loadKeys, loadTasks]);

  async function addKey() {
    setKeyMsg(null);
    const r = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, api_key: apiKey, label }),
    });
    const j = await r.json();
    if (r.ok) {
      setKeyMsg({ ok: true, text: "✅ أُضيف المفتاح بنجاح" });
      setApiKey("");
      setLabel("");
      loadKeys();
    } else {
      setKeyMsg({ ok: false, text: "❌ " + (j.error || "فشل الإضافة") });
    }
  }

  async function toggleKey(k: KeyRow) {
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: k.status !== "disabled" }),
    });
    loadKeys();
  }

  async function deleteKey(k: KeyRow) {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    loadKeys();
  }

  function copy(text: string, what: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  const authHeaders = health?.authRequired
    ? `, "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }`
    : "";
  const origin = typeof window !== "undefined" ? window.location.origin : "<origin>";
  const jsonFor = (kind: "chatgpt" | "claude" | "cursor") => {
    const base = `"url": "${mcpUrl}"${authHeaders}`;
    if (kind === "claude") {
      return `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      ${base}\n    }\n  }\n}`;
    }
    return `{\n  "mcpServers": {\n    "media-generator": {\n      ${base}\n    }\n  }\n}`;
  };

  const dbUp = health?.ok && health.database === "turso-connected";

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      {/* ===== الهيدر ===== */}
      <header className="mb-6 text-center">
        <h1 className="text-3xl font-extrabold">
          <span className="bg-gradient-to-l from-cyan-400 to-violet-500 bg-clip-text text-transparent">
            MCP Media Generator
          </span>
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — تبديل تلقائي للمفاتيح بترتيب تسلسلي
        </p>
        <div className="mt-3 flex items-center justify-center gap-2 text-xs">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-bold ${
              dbUp ? "bg-emerald-400/15 text-emerald-300" : "bg-rose-400/15 text-rose-300"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${dbUp ? "bg-emerald-400" : "bg-rose-400"}`} />
            {dbUp ? "Turso متصل" : "غير متصل"}
          </span>
          <span
            className={`rounded-full px-3 py-1 font-bold ${
              health?.merger.healthy ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-300"
            }`}
          >
            خدمة الدمج: {health?.merger.healthy ? "جاهزة" : "غير مهيأة"}
          </span>
          <span className="rounded-full bg-slate-400/15 px-3 py-1 font-bold text-slate-300">
            {health?.authRequired ? "محمي بـ Bearer Token" : "بدون حماية"}
          </span>
        </div>
      </header>

      {/* ===== أ) مدير المفاتيح ===== */}
      <section className="mb-5 rounded-2xl border border-[#232a40] bg-[#10131f] p-5">
        <h2 className="mb-3 text-lg font-bold">🔑 مدير المفاتيح</h2>
        <p className="mb-4 rounded-xl border border-cyan-400/25 bg-cyan-400/5 px-4 py-2.5 text-xs leading-7 text-cyan-200">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند
          أي خطأ أو نفاد رصيد دون توقف.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="rounded-lg border border-[#232a40] bg-[#141827] px-3 py-2 text-sm"
          >
            <option value="kie">kie.ai</option>
            <option value="cometapi">CometAPI</option>
          </select>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="تسمية اختيارية (مثل: الحساب الأساسي)"
            className="min-w-[180px] flex-1 rounded-lg border border-[#232a40] bg-[#141827] px-3 py-2 text-sm"
          />
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="المفتاح الكامل — يُخفى بعد الإضافة"
            className="min-w-[220px] flex-[2] rounded-lg border border-[#232a40] bg-[#141827] px-3 py-2 text-sm"
            dir="ltr"
          />
          <button
            onClick={addKey}
            className="rounded-lg bg-gradient-to-l from-cyan-400 to-violet-500 px-5 py-2 text-sm font-bold text-[#06121b]"
          >
            ➕ إضافة
          </button>
        </div>
        {keyMsg && (
          <p className={`mt-2 text-xs ${keyMsg.ok ? "text-emerald-300" : "text-rose-300"}`}>{keyMsg.text}</p>
        )}

        <div className="mt-4 space-y-2">
          {keys.length === 0 && (
            <p className="rounded-lg border border-dashed border-[#232a40] px-4 py-6 text-center text-xs text-slate-400">
              لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لبدء التوليد.
            </p>
          )}
          {keys.map((k) => (
            <div
              key={k.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-[#232a40] bg-[#141827] px-3 py-2 text-xs"
            >
              <span className="rounded bg-[#10131f] px-2 py-1 font-bold text-cyan-300" dir="ltr">
                {k.masked}
              </span>
              <span className="font-bold text-slate-300">{PROVIDER_LABEL[k.provider] || k.provider}</span>
              {k.label && <span className="text-slate-400">({k.label})</span>}
              {statusBadge(k.status)}
              <span className="text-slate-400" dir="ltr">
                استُخدم {k.usageCount} | نجح {k.successCount} | فشل {k.failCount}
              </span>
              {k.lastError && (
                <span className="max-w-full truncate text-rose-300/80" title={k.lastError}>
                  آخر خطأ: {k.lastError.slice(0, 60)}
                </span>
              )}
              <span className="flex-1" />
              <button
                onClick={() => toggleKey(k)}
                className="rounded-lg border border-[#232a40] bg-[#10131f] px-3 py-1.5 font-bold hover:border-cyan-400/50"
              >
                {k.status === "disabled" ? "تنشيط" : "تعطيل"}
              </button>
              <button
                onClick={() => deleteKey(k)}
                className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-1.5 font-bold text-rose-300 hover:border-rose-400"
              >
                حذف
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* ===== ب) لوحة المهام ===== */}
      <section className="mb-5 rounded-2xl border border-[#232a40] bg-[#10131f] p-5" ref={tasksRef}>
        <h2 className="mb-3 text-lg font-bold">📊 لوحة المهام</h2>
        <div className="mb-4 flex flex-wrap gap-2 text-xs">
          {[
            ["الإجمالي", stats.total, "text-slate-200"],
            ["مكتملة", stats.completed, "text-emerald-300"],
            ["فاشلة", stats.failed, "text-rose-300"],
            ["جارية", stats.processing, "text-cyan-300"],
          ].map(([labelText, v, cls]) => (
            <span key={labelText as string} className="rounded-xl border border-[#232a40] bg-[#141827] px-4 py-2">
              {labelText}: <b className={cls as string}>{v as number}</b>
            </span>
          ))}
        </div>
        <div className="space-y-2">
          {tasks.length === 0 && (
            <p className="rounded-lg border border-dashed border-[#232a40] px-4 py-6 text-center text-xs text-slate-400">
              لا توجد مهام بعد — المهام تنشأ من استدعاءات MCP.
            </p>
          )}
          {tasks.map((t) => (
            <div key={t.id} className="rounded-lg border border-[#232a40] bg-[#141827] px-3 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base">{typeIcon(t.type)}</span>
                <span className="font-bold text-slate-200">{t.type}</span>
                {statusBadge(t.status)}
                <span className="text-slate-400" dir="ltr">{t.model}</span>
                {t.provider && (
                  <span className="text-slate-500">({PROVIDER_LABEL[t.provider] || t.provider})</span>
                )}
                <span className="text-slate-500">{t.createdAt}</span>
                <span className="text-slate-500">محاولات: {t.attemptsCount}</span>
                <span className="flex-1" />
                {t.status === "completed" &&
                  t.urls.map((u) => (
                    <a
                      key={u}
                      href={u}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg bg-cyan-400/15 px-3 py-1 font-bold text-cyan-300 hover:bg-cyan-400/25"
                    >
                      فتح الرابط ↗
                    </a>
                  ))}
              </div>
              {t.prompt && <p className="mt-1 truncate text-slate-400">الوصف: {t.prompt}</p>}
              {t.status !== "completed" && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#10131f]">
                  <div
                    className="h-full rounded-full bg-gradient-to-l from-cyan-400 to-violet-500 transition-all"
                    style={{ width: `${t.progress}%` }}
                  />
                </div>
              )}
              {t.status === "failed" && t.error && (
                <p className="mt-1.5 text-rose-300/90">{t.error}</p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ===== ج) ربط السيرفر ===== */}
      <section className="rounded-2xl border border-[#232a40] bg-[#10131f] p-5">
        <h2 className="mb-3 text-lg font-bold">🔌 ربط السيرفر</h2>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            readOnly
            value={mcpUrl}
            dir="ltr"
            className="min-w-[280px] flex-1 rounded-lg border border-[#232a40] bg-[#141827] px-3 py-2 text-sm text-cyan-300"
          />
          <button
            onClick={() => copy(mcpUrl, "url")}
            className="rounded-lg border border-[#232a40] bg-[#141827] px-4 py-2 text-sm font-bold hover:border-cyan-400/50"
          >
            {copied === "url" ? "✅ نُسخ" : "📋 نسخ"}
          </button>
        </div>

        <div className="mb-2 flex gap-2 text-xs font-bold">
          {([
            ["chatgpt", "ChatGPT / GPT Agents"],
            ["claude", "Claude Desktop"],
            ["cursor", "Cursor / Windsurf / Cline"],
          ] as const).map(([id, lbl]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded-lg px-3 py-1.5 ${
                tab === id ? "bg-cyan-400/15 text-cyan-300" : "bg-[#141827] text-slate-400"
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>

        <pre className="overflow-x-auto rounded-xl border border-[#232a40] bg-[#070a12] p-4 text-xs leading-6 text-[#9fd6e8]">
          {jsonFor(tab)}
        </pre>
        {tab === "chatgpt" && (
          <p className="mt-2 text-xs leading-7 text-slate-400">
            في ChatGPT: <b>Settings → Connectors → Create → Custom MCP server</b> وضع الرابط في
            <b> Server URL</b>.{health?.authRequired ? " وأضف ترويسة Authorization كما في JSON أعلاه." : ""}
          </p>
        )}
        {tab === "claude" && (
          <p className="mt-2 text-xs leading-7 text-slate-400">
            انسخ الكود إلى ملف <b dir="ltr">claude_desktop_config.json</b> — الصيغة تستخدم
            <b dir="ltr"> "type": "http"</b>.
          </p>
        )}
        {tab === "cursor" && (
          <p className="mt-2 text-xs leading-7 text-slate-400">
            انسخ الكود إلى <b dir="ltr">mcp.json</b> في Cursor / Windsurf / Cline.
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {TOOLS.map((t) => (
            <span
              key={t.name}
              className="rounded-full border border-[#232a40] bg-[#141827] px-3 py-1.5 text-[11px]"
              title={t.desc}
            >
              <b className="text-cyan-300" dir="ltr">{t.name}</b> — <span className="text-slate-400">{t.desc}</span>
            </span>
          ))}
        </div>

        <p className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-2.5 text-xs leading-7 text-amber-200">
          ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند
          اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications)
          حتى لا تنقطع العملية.
        </p>

        <div className="mt-4 text-xs text-slate-400" dir="ltr">
          {health?.models.map((m) => (
            <div key={m.canonical} className="mb-1">
              • <span className="text-cyan-300">{m.canonical}</span> ({m.type}) ← {m.providers.join(" + ")}
            </div>
          ))}
          <div>• merger: {health?.merger.base}</div>
        </div>
      </section>
    </div>
  );
}
