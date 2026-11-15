// سجل الموديلات — الاسم الموحد (canonical) + الصيغ البديلة + المزودون واسم الموديل لكل مزود.
// الأسماء قابلة للتجاوز بمتغيرات البيئة.
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

const KIE_IMAGE = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

export const MODELS: ModelDef[] = [
  {
    canonical: KIE_IMAGE,
    aliases: ["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE, cometapi: COMETAPI_IMAGE },
  },
  {
    canonical: KIE_VIDEO,
    aliases: ["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO, cometapi: COMETAPI_VIDEO },
  },
];

// توحيد اسم الموديل عبر الصيغ البديلة (شرطات/نقاط) — غير معروف → null
export function resolveModel(name: string): ModelDef | null {
  const norm = name.trim().toLowerCase();
  return (
    MODELS.find(
      (m) => m.canonical.toLowerCase() === norm || m.aliases.some((a) => a.toLowerCase() === norm)
    ) || null
  );
}

export function modelByCanonical(canonical: string): ModelDef | null {
  return MODELS.find((m) => m.canonical === canonical) || null;
}
