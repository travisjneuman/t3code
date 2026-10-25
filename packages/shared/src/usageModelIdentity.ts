/**
 * Which real model a usage row belongs to, whatever harness or gateway route
 * carried it. Usage → Breakdown → Model groups rows by `key`, and server price
 * overrides fall back to `modelId`, so one model reads and prices as one row.
 * Fork add-on: one usage row per model.
 *
 * @module usageModelIdentity
 */
import type { UsageProviderKind } from "@t3tools/contracts";

import { formatModelSlugName } from "./model.ts";
import { brandProviderName } from "./modelBrandNames.ts";

export type UsageModelVendor = "openai" | "anthropic" | "xai" | "google";

export interface UsageModelIdentity {
  /** `vendor:modelId` for a known family; `provider:rawModel` otherwise, so nothing merges by guess. */
  readonly key: string;
  readonly vendor: UsageModelVendor | null;
  /** The ID a custom price for this model is stored under. */
  readonly modelId: string;
  readonly displayName: string;
  /** The gateway route's brand ("Codex" for Pi's `openai-codex/…`), or `null` for a direct harness. */
  readonly route: string | null;
  /** The gateway route's raw slug, for route-specific notes. */
  readonly routeSlug: string | null;
  /** A context tier such as "1M context", which stays a sub-line of the base model. */
  readonly tier: string | null;
  /** Usage no model can claim, such as Pi's tool and summary calls; `null` for a real model. */
  readonly unattributed: string | null;
}

/** The vendor's own harness: its usage needs no "via" label, and its mark stands for the model. */
export const USAGE_VENDOR_HARNESS: Readonly<Record<UsageModelVendor, UsageProviderKind>> = {
  openai: "codex",
  anthropic: "claude",
  xai: "grok",
  google: "antigravity",
};

const VENDOR_FAMILIES: ReadonlyArray<readonly [RegExp, UsageModelVendor]> = [
  [/^gpt-/, "openai"],
  [/^o\d/, "openai"],
  [/^codex-/, "openai"],
  [/^claude-/, "anthropic"],
  [/^grok-/, "xai"],
  [/^gemini-/, "google"],
];

function unattributedUsage(provider: UsageProviderKind, rawModel: string): string | null {
  if (rawModel === "Tools/summaries") return "tools and summaries";
  if (provider === "grok" && rawModel === "grok") return "with no model reported";
  if (rawModel === "<synthetic>" || rawModel === "synthetic") return "synthetic messages";
  return null;
}

function tierLabel(tier: string): string {
  return /^\d+[km]$/i.test(tier) ? `${tier.toUpperCase()} context` : tier;
}

/**
 * Splits a raw usage model into its vendor model ID and context tier. Claude's
 * dated snapshots fold into the undated ID, Anthropic's documented alias form.
 * The Grok CLI reports `grok-N` as `grok-N-build` and its Fast tier as
 * `grok-N-build-fast` (a speed, not a model). Every other suffix is a distinct model.
 */
function parseModel(rawModel: string) {
  const bare = rawModel
    .slice(rawModel.lastIndexOf("/") + 1)
    .trim()
    .toLowerCase();
  const tierMatch = /\[([^\]]+)\]$/.exec(bare);
  const untiered = tierMatch === null ? bare : bare.slice(0, tierMatch.index);
  const modelId = untiered.startsWith("claude-")
    ? untiered.replace(/-\d{8}$/, "")
    : untiered.startsWith("grok-")
      ? untiered.replace(/(\d)-build(?:-fast)?$/, "$1")
      : untiered;
  const vendor = VENDOR_FAMILIES.find(([family]) => family.test(modelId))?.[1] ?? null;
  return { modelId, vendor, tier: tierMatch === null ? null : tierLabel(tierMatch[1]!) };
}

/** The ID a custom price for `rawModel` is stored under; the raw model when its family is unknown. */
export function usageModelPriceId(rawModel: string): string {
  const trimmed = rawModel.trim();
  const { modelId, vendor } = parseModel(trimmed);
  return vendor === null ? trimmed : modelId;
}

export function usageModelIdentity(
  provider: UsageProviderKind,
  rawModel: string,
): UsageModelIdentity {
  const trimmed = rawModel.trim();
  const unattributed = unattributedUsage(provider, trimmed);
  const slash = trimmed.lastIndexOf("/");
  const routeSlug = unattributed === null && slash > 0 ? trimmed.slice(0, slash) : null;
  const route = routeSlug === null ? null : brandProviderName(routeSlug);
  const { modelId, vendor, tier } = parseModel(trimmed);
  if (unattributed !== null || vendor === null) {
    return {
      key: `${provider}:${trimmed}`,
      vendor: null,
      modelId: trimmed,
      displayName: unattributed ?? formatModelSlugName(trimmed),
      route,
      routeSlug,
      tier: null,
      unattributed,
    };
  }
  return {
    key: `${vendor}:${modelId}`,
    vendor,
    modelId,
    displayName: formatModelSlugName(modelId),
    route,
    routeSlug,
    tier,
    unattributed: null,
  };
}
