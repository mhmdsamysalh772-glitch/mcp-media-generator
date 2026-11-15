# ⚡ MCP Media Generator

خادم **MCP** (Model Context Protocol) لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — مع لوحة إدارة عربية RTL.

يجمع ثلاث قدرات في أداة واحدة عبر بروتوكول MCP القياسي، فيستدعيها أي عميل (ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK):

1. **توليد صور** — `gpt-image-2-6/flare-text-to-image`
2. **توليد فيديو بصوت متزامن أصلي** — `grok-imagine-video-1-5-preview`
3. **دمج عدة مقاطع في فيديو واحد** — عبر خدمة Video Merger API

> خدمة الدمج هي مشروع منفصل: [video-merger-api](https://github.com/mhmdsamysalh772-glitch/video-merger-api) — انشرها أولًا واستخدم رابطها في `MERGER_API_BASE`.

---

## 🧠 القواعد الجوهرية (كيف يعمل)

- **لا يُنزَّل أي ملف وسائط على السيرفر** — نرسل الروابط للمزودين ونخزّن روابط النتائج فقط في قاعدة البيانات
- **المفاتيح تُجرَّب بترتيب تسلسلي صارم** حسب ترتيب إضافتها (أول مفتاح أُضيف يُجرَّب أولًا…) مع **تبديل تلقائي فوري** عند أي خطأ أو نفاد رصيد دون توقف المهمة — نفس المهمة تُستأنف بنفس `task_id` على المفتاح التالي
- **نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا** — التبديل صامت تمامًا من وجهة نظره
- مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد تلقائيًا مع كل `get_task` (بتهدئة 45 ثانية) — لو شُحن رصيد أي مفتاح تكتمل من تلقاء نفسها
- التوليد غير متزامن: الأداة تعيد `task_id` فورًا (مع نافذة انتظار قصيرة تبث تقدمًا حيًا)، والعميل يتابع بأداة `get_task` كل ~10 ثوانٍ

---

## 🚀 النشر على Vercel خطوة بخطوة

### 0) المتطلبات المسبقة

- قاعدة **Turso** مجانية + خدمة **video-merger-api** منشورة على Vercel (رابطها يصبح `MERGER_API_BASE`)
- مفتاح **kie.ai** واحد على الأقل (يُضاف من لوحة الإدارة بعد النشر — لا يوضع في أي ملف)

### 1) إنشاء قاعدة Turso (إن لم تكن جاهزة)

```bash
turso auth login
turso db create media-generator
turso db show media-generator --url          # → TURSO_DATABASE_URL
turso db tokens create media-generator        # → TURSO_AUTH_TOKEN
```

### 2) النشر

1. **Import** هذا المستودع في Vercel (الإطار يُكتشف تلقائيًا: Next.js).
2. أضف متغيرات البيئة في **Settings → Environment Variables** (للثلاث بيئات):

| المتغير | إلزامي | القيمة |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | `libsql://<db-name>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | ✅ | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | ✅ | رابط خدمة الدمج المنشورة، مثل `https://video-merger-api.vercel.app` |
| `MCP_ACCESS_TOKEN` | — | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `MAX_WAIT_SECONDS` | — | `50` (حد أمان نافذة الانتظار داخل استدعاء الأداة) |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` / `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | — | تجاوز أسماء الموديلات إن لزم |

3. **Deploy** — الجداول (`tasks` و `api_keys`) تُنشأ تلقائيًا عند أول وصول.

> **ملاحظة عن مدة الدالة:** `maxDuration = 60` (حد خطة Hobby). نافذة الانتظار داخل الأداة تُقتطع بـ `MAX_WAIT_SECONDS=50` حتى لا تُقتل الدالة منتصف البث؛ ما يتجاوزها يعيد `task_id` ويتابَع بـ `get_task`. على خطة Pro ارفع القيمتين معًا (حتى 240).

### 3) بعد النشر — أضف مفاتيحك

افتح رابط المشروع → بطاقة **مدير المفاتيح** → اختر المزود (kie.ai / CometAPI) → أضف المفتاح (يُخفى فورًا ولا يُعاد كاملًا في أي استجابة). أضف **عدة مفاتيح** لكل مزود ليشتغل التبديل التسلسلي.

---

## 🔌 الربط بأي عميل MCP

الرابط: `<origin>/mcp` — يظهر في بطاقة «ربط السيرفر» جاهزًا للنسخ مع صيغ JSON لثلاث فئات عملاء:

- **ChatGPT / GPT Agents**: Settings → Connectors → Create → Custom MCP server وضع الرابط في Server URL
- **Claude Desktop**: في `claude_desktop_config.json` بصيغة `"type": "http"`
- **Cursor / Windsurf / Cline**: في `mcp.json`

### الأدوات الخمس

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة من وصف نصي (+ نسبة أبعاد، دقة، خلفية، صيغة) |
| `generate_video` | توليد فيديو بصوت متزامن (+ صورة أول إطار اختيارية، مدة 1–15 ثانية) |
| `merge_videos` | دمج 2–10 مقاطع بترتيب محدد — بروابط مباشرة أو `task_ids` لمهام مكتملة |
| `get_task` | تتبع أي مهمة بمعرّفها — تحديث حي من المزود أو خدمة الدمج |
| `list_media` | أحدث الوسائط المخزنة بروابطها (استرجاع نتائج سابقة) |

### اختبار سريع بعد النشر

```bash
# التهيئة
curl -s -X POST https://<your-app>.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# قائمة الأدوات
curl -s -X POST https://<your-app>.vercel.app/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# توليد صورة
curl -s -X POST https://<your-app>.vercel.app/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"a red apple","wait_seconds":40}}}'

# فحص الصحة
curl https://<your-app>.vercel.app/api/health
```

---

## 🗂️ بنية الكود

```
src/
├── app/
│   ├── mcp/route.ts            ← خادم MCP (Streamable HTTP، وضع عديم الجلسة — مناسب لـ serverless)
│   ├── api/health/route.ts     ← فحص شامل (قاعدة + موديلات + خدمة الدمج)
│   ├── api/keys/…              ← إدارة المفاتيح (GET/POST/PATCH/DELETE — مقنَّعة دائمًا)
│   ├── api/tasks/route.ts      ← تغذية لوحة المهام (تحديث كل 5 ثوانٍ)
│   └── page.tsx                ← لوحة الإدارة العربية RTL
└── lib/
    ├── turso.ts                ← طبقة القاعدة + المخطط التلقائي
    ├── models.ts               ← سجل الموديلات (canonical/aliases/providers + تجاوز بالبيئة)
    ├── errors.ts               ← classifyProviderError (disabled/exhausted/provider/params/temporary)
    ├── keys.ts                 ← البركة التسلسلية + العدّادات + maskKey
    ├── providers/kie.ts        ← مزود kie.ai (Jobs API — أشكال مُقاسة فعليًا)
    ├── providers/cometapi.ts   ← مزود CometAPI (صور متزامنة + فيديو بمهام)
    ├── merger.ts               ← عميل خدمة الدمج (تحليل دفاعي للحالة)
    ├── generation.ts           ← منسّق التوليد + التبديل الصامت + الدمج + refreshTask
    └── mcp-server.ts           ← الأدوات الخمس + SERVER_INSTRUCTIONS
```

## 🧪 الفحص المحلي

```bash
npm install
npm run dev          # http://localhost:3000
npm run typecheck    # tsc --noEmit
npm run build        # بناء الإنتاج
```

- `/api/health` يجب أن يرجع `ok:true` و `database:"turso-connected"` و `merger.healthy:true`
- أضف مفتاحًا من الواجهة ثم جرّب توليد صورة من أي عميل MCP

## ⚠️ حدود يجب معرفتها

- **مدة الدالة على Vercel Hobby = 60 ثانية** → نافذة الانتظار ≤50 ثانية ثم `task_id` (الفيديو دائمًا تقريبًا يتابَع بـ `get_task`)
- **خطة kie.ai**: كل توليد يستهلك كريدت — مفتاح مستنزف يُعلَّم `exhausted` تلقائيًا وتبقى المهام تعمل على المفاتيح التالية
- ملفات الدمج تُحذف من خدمة الدمج بعد **24 ساعة** — التنبيه مدمج في وصف الأداة وتعليمات السيرفر
- التبديل التسلسلي يعمل عبر مزودين (`kie` + `cometapi`) — لا مشكلة إن أضفت مفاتيح مزود واحد فقط
