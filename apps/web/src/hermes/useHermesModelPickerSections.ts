import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useRef, useState, type RefObject } from "react";

import { modelPickerModelKey } from "../components/chat/modelPickerKeys";
import * as HermesGroups from "./hermesModelGroups";

/** Keeps Hermes's grouped navigation outside the upstream model picker. */
export function useHermesModelPickerSections<
  T extends {
    readonly slug: string;
    readonly instanceId: ProviderInstanceId;
    readonly subProvider?: string | undefined;
  },
>(input: {
  activeDriverKind: ProviderDriverKind | undefined;
  activeInstanceId: ProviderInstanceId;
  activeModelSlug: string;
  selectedInstanceId: ProviderInstanceId | "favorites";
  entryByInstanceId: ReadonlyMap<ProviderInstanceId, { readonly driverKind: ProviderDriverKind }>;
  isSearching: boolean;
  filteredModels: ReadonlyArray<T>;
  /** Every model in the picker, for the combobox's full item list. */
  flatModels: Parameters<typeof HermesGroups.hermesModelGroupKeys>[0];
  modelListRef: RefObject<LegendListRef | null>;
}) {
  const [expandedHermesGroups, setExpandedHermesGroups] = useState(() =>
    HermesGroups.initialHermesExpandedGroups(
      input.activeDriverKind,
      input.activeInstanceId,
      input.activeModelSlug,
    ),
  );
  const selectedDriverKind =
    input.selectedInstanceId === "favorites"
      ? undefined
      : input.entryByInstanceId.get(input.selectedInstanceId)?.driverKind;
  const hermesSections =
    input.isSearching ||
    input.selectedInstanceId === "favorites" ||
    !HermesGroups.isHermesDriver(selectedDriverKind)
      ? null
      : HermesGroups.buildHermesModelSections(
          input.filteredModels,
          input.selectedInstanceId,
          expandedHermesGroups,
          (model) => modelPickerModelKey(model.instanceId, model.slug),
        );

  // Opening a group removes the previous group's rows above it. Scroll only after
  // the virtualized list has received the new keys, so its header stays in view.
  const scrollToGroupRef = useRef<string | null>(null);
  const toggleHermesGroup = (key: string | null) => {
    if (!HermesGroups.isHermesModelGroupKey(key)) return false;
    scrollToGroupRef.current = key;
    setExpandedHermesGroups((expanded) => HermesGroups.toggleHermesModelGroup(expanded, key));
    return true;
  };
  const itemKeys = hermesSections?.itemKeys;
  const modelListRef = input.modelListRef;
  useEffect(() => {
    const key = scrollToGroupRef.current;
    if (key === null) return;
    scrollToGroupRef.current = null;
    const index = itemKeys?.indexOf(key) ?? -1;
    if (index >= 0) {
      void modelListRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0 });
    }
  }, [itemKeys, modelListRef]);

  const showHermesModelProvider = (model: T) =>
    hermesSections === null ||
    HermesGroups.hermesModelGroupKeyOf(model.instanceId, model.slug) === null;

  return {
    sections: hermesSections,
    expandedGroups: expandedHermesGroups,
    groupKeys: HermesGroups.hermesModelGroupKeys(input.flatModels),
    groupFor: (key: string) => hermesSections?.groups.find((group) => group.key === key),
    /** True when `key` is a group header, which it opened or closed instead of selecting. */
    toggleGroup: toggleHermesGroup,
    showProvider: showHermesModelProvider,
  };
}
