// طبقة Turso — عميل واحد عبر HTTP (متوافق مع Vercel serverless) + مخطط يُنشأ عند أول وصول
import { createClient, type Client, type InValue } from "@libsql/client";

let _client: Client | null = null;

export function getDb(): Client {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
  }
  if (!_client) {
    _client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _client;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await getDb().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

let _schema: Promise<void> | null = null;
export async function ensureSchema(): Promise<void> {
  if (!_schema) {
    _schema = (async () => {
      const db = getDb();
      await db.batch([
        `CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
      ]);
    })().catch((e) => { _schema = null; throw e; });
  }
  return _schema;
}

// ===== أنواع الصفوف =====
export interface Attempt {
  provider: string;
  keyId: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  params_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ApiKeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

// تحويل تاريخ Turso 'YYYY-MM-DD HH:MM:SS' (UTC) إلى Date
export function parseDbDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? null : d;
}

export async function insertTask(t: {
  id: string;
  provider?: string;
  provider_task_id?: string;
  key_id?: string;
  model: string;
  type: "image" | "video" | "merge";
  prompt?: string;
  params_json?: string;
  status?: string;
}): Promise<void> {
  await getDb().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [t.id, t.provider ?? null, t.provider_task_id ?? null, t.key_id ?? null,
      t.model, t.type, t.prompt ?? "", t.params_json ?? "{}", t.status ?? "processing"],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  const res = await getDb().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return (res.rows[0] as unknown as TaskRow) || null;
}

// تحديث جزئي: يضيف attempt جديد إلى attempts_json ويضبط completed_at تلقائيًا عند الاكتمال
export async function updateTask(
  id: string,
  patch: Partial<Omit<TaskRow, "id" | "attempts_json" | "completed_at" | "created_at" | "updated_at">> & { attempt?: Attempt } = {}
): Promise<void> {
  const cols: string[] = [];
  const args: InValue[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === "attempt") continue;
    cols.push(`${k} = ?`);
    args.push(v as InValue);
  }
  if (patch.attempt) {
    const current = await getDb().execute({ sql: "SELECT attempts_json FROM tasks WHERE id = ?", args: [id] });
    let arr: Attempt[] = [];
    try { arr = JSON.parse(String(current.rows[0]?.attempts_json || "[]")); } catch { /* ابدأ من جديد */ }
    arr.push(patch.attempt);
    cols.push("attempts_json = ?");
    args.push(JSON.stringify(arr));
  }
  if (patch.status === "completed") {
    cols.push("completed_at = datetime('now')");
  }
  cols.push("updated_at = datetime('now')");
  args.push(id);
  await getDb().execute({ sql: `UPDATE tasks SET ${cols.join(", ")} WHERE id = ?`, args });
}

export async function listRecentTasks(
  limit = 10,
  filters: { type?: string; status?: string } = {}
): Promise<TaskRow[]> {
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters.type) { where.push("type = ?"); args.push(filters.type); }
  if (filters.status) { where.push("status = ?"); args.push(filters.status); }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, updated_at DESC LIMIT ?`;
  args.push(limit);
  const res = await getDb().execute({ sql, args });
  return res.rows as unknown as TaskRow[];
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  const res = await getDb().execute(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'processing' OR status = 'pending' THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const r = res.rows[0];
  return {
    total: Number(r?.total ?? 0),
    completed: Number(r?.completed ?? 0),
    failed: Number(r?.failed ?? 0),
    processing: Number(r?.processing ?? 0),
  };
}
