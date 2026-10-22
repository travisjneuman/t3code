/**
 * Folds Usage model rows, which upstream keys by harness plus raw model, into
 * one row per real model with a route line for each harness, gateway route and
 * context tier that carried it. It runs on merged totals, after source
 * ownership and de-duplication, so no usage can drop out and the wire, cache
 * and mobile client stay unchanged.
 * Fork add-on: one usage row per model.
 *
 * @module usageModelGroups
 */
import type { UsageProviderKind, UsageTokenTotals } from "@t3tools/contracts";

import type { MergedUsage, ModelTotals } from "./usageMerge.ts";
import {
  USAGE_VENDOR_HARNESS,
  usageModelIdentity,
  type UsageModelIdentity,
  type UsageModelVendor,
} from "./usageModelIdentity.ts";

/** One harness, gateway route and tier of a model. `model` is its largest raw model. */
export interface UsageModelRoute extends ModelTotals {
  readonly route: string | null;
  readonly routeSlug: string | null;
  readonly tier: string | null;
  readonly rawModels: readonly string[];
}

export interface UsageModelGrouping {
  readonly key: string;
  readonly vendor: UsageModelVendor | null;
  readonly displayName: string;
  readonly unattributed: string | null;
  /** Largest first by cost, then tokens. */
  readonly routes: readonly UsageModelRoute[];
}

/**
 * A grouped row. Its totals sum every route; `model` is the price ID and
 * `provider` the mark that stands for the model (the vendor's own harness).
 */
export interface UsageModelRow extends ModelTotals {
  readonly grouping: UsageModelGrouping;
}

export function isUsageModelRow(model: ModelTotals): model is UsageModelRow {
  return "grouping" in model;
}

function addTokens(left: UsageTokenTotals, right: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

type Totals = Omit<ModelTotals, "model" | "provider">;

function addTotals(left: Totals, right: Totals): Totals {
  return {
    costUsd: left.costUsd + right.costUsd,
    totalTokens: left.totalTokens + right.totalTokens,
    tokens: addTokens(left.tokens, right.tokens),
    records: left.records + right.records,
    unpricedRecords: left.unpricedRecords + right.unpricedRecords,
    unpricedTokens: left.unpricedTokens + right.unpricedTokens,
    costShare: left.costShare + right.costShare,
    tokenShare: left.tokenShare + right.tokenShare,
  };
}

function sumTotals(parts: readonly ModelTotals[]): Totals {
  return parts.reduce<Totals>((sum, part) => addTotals(sum, part), {
    costUsd: 0,
    totalTokens: 0,
    tokens: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    records: 0,
    unpricedRecords: 0,
    unpricedTokens: 0,
    costShare: 0,
    tokenShare: 0,
  });
}

const byCostThenTokens = (left: ModelTotals, right: ModelTotals) =>
  right.costUsd - left.costUsd || right.totalTokens - left.totalTokens;

export function groupUsageModelRows(models: readonly ModelTotals[]): readonly UsageModelRow[] {
  const groups = new Map<
    string,
    { readonly identity: UsageModelIdentity; readonly routes: Map<string, ModelTotals[]> }
  >();
  for (const model of models) {
    const identity = usageModelIdentity(model.provider, model.model);
    const group = groups.get(identity.key) ?? {
      identity,
      routes: new Map<string, ModelTotals[]>(),
    };
    const routeKey = JSON.stringify([model.provider, identity.routeSlug, identity.tier]);
    group.routes.set(routeKey, [...(group.routes.get(routeKey) ?? []), model]);
    groups.set(identity.key, group);
  }

  return [...groups.values()]
    .map(({ identity, routes }): UsageModelRow => {
      const routeRows = [...routes.values()]
        .map((parts): UsageModelRoute => {
          const sorted = parts.toSorted(byCostThenTokens);
          const first = sorted[0]!;
          const routeIdentity = usageModelIdentity(first.provider, first.model);
          return {
            ...sumTotals(sorted),
            model: first.model,
            provider: first.provider,
            route: routeIdentity.route,
            routeSlug: routeIdentity.routeSlug,
            tier: routeIdentity.tier,
            rawModels: sorted.map((part) => part.model),
          };
        })
        .toSorted(byCostThenTokens);
      const first = routeRows[0]!;
      const provider: UsageProviderKind =
        identity.vendor === null ? first.provider : USAGE_VENDOR_HARNESS[identity.vendor];
      return {
        ...sumTotals(routeRows),
        model: identity.modelId,
        provider,
        grouping: {
          key: identity.key,
          vendor: identity.vendor,
          displayName: identity.displayName,
          unattributed: identity.unattributed,
          routes: routeRows,
        },
      };
    })
    .toSorted(byCostThenTokens);
}

export function groupUsageModels(merged: MergedUsage): MergedUsage {
  return { ...merged, models: groupUsageModelRows(merged.models) };
}
