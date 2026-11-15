// فهرس المزودات
import type { ProviderId } from "../models";
import { cometApiAdapter } from "./cometapi";
import { kieAdapter } from "./kie";
import type { ProviderAdapter } from "./types";

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometApiAdapter,
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  return ADAPTERS[provider];
}

export type { ProviderAdapter, ProviderCheckResult } from "./types";
