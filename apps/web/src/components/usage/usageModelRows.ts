/**
 * Presentation for grouped Usage model rows: route labels, the row's split
 * bar, and the selection and bucket matching the model dialog uses.
 * Fork add-on: one usage row per model.
 */
import type { UsageBucket, UsageProviderKind } from "@t3tools/contracts";
import type { ModelTotals } from "@t3tools/shared/usageMerge";
import {
  groupUsageModelRows,
  isUsageModelRow,
  type UsageModelRoute,
  type UsageModelRow,
} from "@t3tools/shared/usageModelGroups";
import { USAGE_VENDOR_HARNESS, usageModelIdentity } from "@t3tools/shared/usageModelIdentity";

import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "./usageProviders";

/** Rows from `mergeAnsweredUsage` are already grouped; anything else is grouped on its own. */
export function usageModelRow(model: ModelTotals): UsageModelRow {
  return isUsageModelRow(model) ? model : groupUsageModelRows([model])[0]!;
}

export function usageModelSelectionKey(model: ModelTotals): string {
  return usageModelRow(model).grouping.key;
}

/** Keeps the buckets of every route of `model`, for the dialog's chart and cost splits. */
export function usageModelBucketFilter(model: ModelTotals): (bucket: UsageBucket) => boolean {
  const key = usageModelSelectionKey(model);
  return (bucket) => usageModelIdentity(bucket.provider, bucket.model).key === key;
}

export function usageModelTitle(model: ModelTotals): string {
  const { grouping } = usageModelRow(model);
  return grouping.unattributed === null
    ? grouping.displayName
    : `${PROVIDER_PRESENTATION[model.provider].label} ${grouping.unattributed}`;
}

export function usageRouteLabel(route: UsageModelRoute): string {
  const harness = PROVIDER_PRESENTATION[route.provider].label;
  const label = route.route === null ? harness : `${harness} · ${route.route}`;
  return route.tier === null ? label : `${label} · ${route.tier}`;
}

/** Pi's `openai` provider takes an API key or a ChatGPT sign-in, and transcripts don't say which. */
export function usageRouteNote(route: UsageModelRoute): string | null {
  return route.routeSlug?.toLowerCase() === "openai"
    ? "Through an OpenAI API key or a ChatGPT sign-in."
    : null;
}

/** A sole route through the vendor's own harness needs no label; any other route does. */
export function usageModelSoleRouteNeedsLabel(row: UsageModelRow): boolean {
  const [route] = row.grouping.routes;
  return (
    row.grouping.routes.length === 1 &&
    route !== undefined &&
    row.grouping.vendor !== null &&
    (route.route !== null ||
      route.tier !== null ||
      route.provider !== USAGE_VENDOR_HARNESS[row.grouping.vendor])
  );
}

/** Routes in harness order, for the dialog's chart. */
export function usageModelChartProviders(model: ModelTotals): readonly UsageProviderKind[] {
  const providers = new Set(usageModelRow(model).grouping.routes.map((route) => route.provider));
  return PROVIDER_ORDER.filter((provider) => providers.has(provider));
}

export function usageModelRouteSummary(model: ModelTotals): string {
  return usageModelRow(model).grouping.routes.map(usageRouteLabel).join(", ");
}

/**
 * Pi routes share Pi's color, so each later route of a harness is drawn
 * lighter to keep its segment and its sub-line dot apart.
 */
export function usageRouteColors(routes: readonly UsageModelRoute[]): readonly string[] {
  const seen = new Map<UsageProviderKind, number>();
  return routes.map((route) => {
    const index = seen.get(route.provider) ?? 0;
    seen.set(route.provider, index + 1);
    const color = PROVIDER_PRESENTATION[route.provider].color;
    return index === 0
      ? color
      : `color-mix(in oklab, ${color} ${Math.max(35, 100 - index * 30)}%, var(--background))`;
  });
}
