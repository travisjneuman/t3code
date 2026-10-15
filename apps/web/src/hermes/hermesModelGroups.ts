/**
 * The model picker's Hermes list: "Default" (and any model without a
 * provider) on top, then one collapsible group per Hermes provider, named by
 * the models' `subProvider`. Group headers are list items of their own, so the
 * virtualized list and keyboard navigation treat them like rows.
 * Fork add-on: Hermes provider.
 *
 * @module hermes/hermesModelGroups
 */
import {
  HERMES_DEFAULT_MODEL,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import { getTriggerDisplayModelLabel, type ModelEsque } from "../components/chat/providerIconUtils";
import { HERMES_DRIVER, hermesModelProvider } from "./hermesSessions";

const GROUP_KEY_PREFIX = "hermes-group:";

/** The list key of a provider group's header. */
export function hermesModelGroupKey(instanceId: ProviderInstanceId, provider: string): string {
  return `${GROUP_KEY_PREFIX}${instanceId.length}:${instanceId}${provider}`;
}

/** True for a header key made by `hermesModelGroupKey`. */
export function isHermesModelGroupKey(key: string | null): key is string {
  return key?.startsWith(GROUP_KEY_PREFIX) === true;
}

/** The header key of the group holding `model`, or null for Hermes's default. */
export function hermesModelGroupKeyOf(instanceId: ProviderInstanceId, model: string) {
  const provider = hermesModelProvider(model);
  return provider === null ? null : hermesModelGroupKey(instanceId, provider);
}

/** True for an instance the picker lists in Hermes provider groups. */
export function isHermesDriver(driverKind: ProviderDriverKind | undefined): boolean {
  return driverKind === HERMES_DRIVER;
}

/** The groups open when the picker opens: the one holding the selected model. */
export function initialHermesExpandedGroups(
  driverKind: ProviderDriverKind | undefined,
  instanceId: ProviderInstanceId,
  model: string,
): ReadonlySet<string> {
  const key = isHermesDriver(driverKind) ? hermesModelGroupKeyOf(instanceId, model) : null;
  return new Set(key === null ? [] : [key]);
}

/** Every group header key across the picker's models, for the combobox's item list. */
export function hermesModelGroupKeys(
  models: ReadonlyArray<{
    readonly slug: string;
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: ProviderDriverKind;
  }>,
): ReadonlyArray<string> {
  const keys = new Set<string>();
  for (const model of models) {
    if (!isHermesDriver(model.driverKind)) continue;
    const key = hermesModelGroupKeyOf(model.instanceId, model.slug);
    if (key !== null) keys.add(key);
  }
  return [...keys];
}

export interface HermesModelGroup<T> {
  readonly key: string;
  readonly name: string;
  readonly models: ReadonlyArray<T>;
  readonly isExpanded: boolean;
}

export interface HermesModelSections<T> {
  readonly groups: ReadonlyArray<HermesModelGroup<T>>;
  /** The rows to render: ungrouped models, then each header and its models when expanded. */
  readonly visibleModels: ReadonlyArray<T>;
  /** `visibleModels` keys with the header keys in place. */
  readonly itemKeys: ReadonlyArray<string>;
}

/**
 * Splits one instance's models (already sorted) into the picker's sections.
 * Groups are ordered by name; models keep their order inside a group.
 */
export function buildHermesModelSections<
  T extends { readonly slug: string; readonly subProvider?: string | undefined },
>(
  models: ReadonlyArray<T>,
  instanceId: ProviderInstanceId,
  expandedKeys: ReadonlySet<string>,
  modelKey: (model: T) => string,
): HermesModelSections<T> {
  const ungrouped: T[] = [];
  const byKey = new Map<string, { name: string; models: T[] }>();
  for (const model of models) {
    const provider = hermesModelProvider(model.slug);
    if (provider === null) {
      ungrouped.push(model);
      continue;
    }
    const key = hermesModelGroupKey(instanceId, provider);
    const group = byKey.get(key);
    if (group) group.models.push(model);
    else byKey.set(key, { name: model.subProvider ?? provider, models: [model] });
  }
  const groups = [...byKey]
    .map(([key, group]) => ({ key, ...group, isExpanded: expandedKeys.has(key) }))
    .toSorted((left, right) => left.name.localeCompare(right.name));

  const visibleModels = [...ungrouped];
  const itemKeys = ungrouped.map(modelKey);
  for (const group of groups) {
    itemKeys.push(group.key);
    if (!group.isExpanded) continue;
    visibleModels.push(...group.models);
    itemKeys.push(...group.models.map(modelKey));
  }
  return { groups, visibleModels, itemKeys };
}

/** Opening a group closes the others, so one is open at a time; clicking the open one closes it. */
export function toggleHermesModelGroup(expanded: ReadonlySet<string>, key: string) {
  return new Set(expanded.has(key) ? [] : [key]);
}

/** The composer chip: the agent name, plus the picked model or "Default" for Hermes's own. */
export function hermesComposerTriggerLabel(
  agentName: string,
  model: string,
  options: ReadonlyArray<ModelEsque>,
): string {
  if (model === HERMES_DEFAULT_MODEL || model === "hermes-agent") {
    return `${agentName} · Default`;
  }
  const option = options.find((candidate) => candidate.slug === model);
  return `${agentName} · ${option ? getTriggerDisplayModelLabel(option) : model}`;
}
