/**
 * Settings › Providers › Hermes Agent › Models: Hermes's models grouped by the
 * Hermes provider that serves them. A group's switch hides the whole provider
 * (`hiddenProviders`, applied by the server); a model's switch hides just that
 * model (the instance's hidden models). Both only change what T3 offers;
 * Hermes itself is untouched. Fork add-on: Hermes provider.
 */
import {
  type EnvironmentId,
  HERMES_DEFAULT_MODEL,
  type HermesProviderSummary,
  type ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { useStableCallback } from "../hooks/useStableCallback";
import { cn } from "../lib/utils";
import { hermesModelProvider, hermesSessionsProviders, runHermes } from "./hermesSessions";

const FILTER_THRESHOLD = 8;

const ROW_CLASS = "flex min-h-9 items-center gap-2 px-3 sm:px-4";

const lockedReason = (provider: HermesProviderSummary) =>
  !provider.offerable
    ? "Never offered through Hermes: its terms do not allow use from another app."
    : "Not signed in on Hermes.";

export function HermesModelsSection(props: {
  readonly target: {
    readonly environmentId: EnvironmentId;
    readonly instanceId: ProviderInstanceId;
  };
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly hiddenProviders: ReadonlyArray<string>;
  readonly onHiddenProvidersChange: (next: ReadonlyArray<string>) => void;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly onHiddenModelsChange: (
    next: ReadonlyArray<string>,
    affectedModels?: ReadonlyArray<string>,
  ) => void;
  readonly readOnly: boolean;
  readonly canWritePreferences: boolean;
}) {
  const { target } = props;
  const [providers, setProviders] = useState<ReadonlyArray<HermesProviderSummary> | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");

  const load = useStableCallback(async () => {
    setLoading(true);
    const result = await runHermes(
      hermesSessionsProviders,
      target.environmentId,
      { instanceId: target.instanceId },
      "Could not list Hermes providers",
    );
    setLoading(false);
    if (result !== null) setProviders(result.providers);
  });

  useEffect(() => {
    void load();
  }, [load, target.environmentId, target.instanceId]);

  const hiddenProviders = new Set(props.hiddenProviders);
  const hiddenModels = new Set(props.hiddenModels);
  const modelsByProvider = (() => {
    const out = new Map<string, ServerProviderModel[]>();
    for (const model of props.models) {
      const slug = hermesModelProvider(model.slug);
      if (slug === null) continue;
      const list = out.get(slug);
      if (list) list.push(model);
      else out.set(slug, [model]);
    }
    return out;
  })();

  // A provider the user hid is still listed, so it can be shown again.
  const isUsable = (provider: HermesProviderSummary) =>
    provider.offerable &&
    (provider.authenticated ||
      hiddenProviders.has(provider.slug) ||
      modelsByProvider.has(provider.slug));
  const byName = (left: HermesProviderSummary, right: HermesProviderSummary) =>
    left.name.localeCompare(right.name);
  const usable = (providers ?? []).filter(isUsable).toSorted(byName);
  const locked = (providers ?? []).filter((provider) => !isUsable(provider)).toSorted(byName);

  const query = filter.trim().toLowerCase();
  const showFilter = props.models.length > FILTER_THRESHOLD;
  const matches = (model: ServerProviderModel) =>
    query === "" ||
    model.name.toLowerCase().includes(query) ||
    model.slug.toLowerCase().includes(query);
  const canEditProviders = !props.readOnly;
  const canEditModels = props.canWritePreferences;

  const toggleProvider = (slug: string, shown: boolean) => {
    const next = new Set(hiddenProviders);
    if (shown) next.delete(slug);
    else next.add(slug);
    props.onHiddenProvidersChange([...next].toSorted());
  };
  const toggleModel = (slug: string, shown: boolean) => {
    if (shown === !hiddenModels.has(slug)) return;
    props.onHiddenModelsChange(
      shown ? props.hiddenModels.filter((model) => model !== slug) : [...props.hiddenModels, slug],
      [slug],
    );
  };
  const toggleExpanded = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const groupHeader = (key: string, open: boolean, title: string, detail: string) => (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => toggleExpanded(key)}
      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 text-left"
    >
      <ChevronRightIcon
        aria-hidden
        className={cn("size-3.5 shrink-0 text-muted-foreground", open && "rotate-90")}
      />
      <span className="truncate text-sm font-medium text-foreground">{title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>
    </button>
  );

  return (
    <SettingsSection
      title="Models"
      headerAction={
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          className="redesign:-me-2" // Fork add-on: match upstream's flush header buttons.
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "Loading" : "Refresh"}
        </Button>
      }
    >
      <div className="px-3 pt-3 sm:px-4">
        <p className="text-xs text-muted-foreground">
          Choose what T3 offers from Hermes. Hiding a provider or model here changes nothing on
          Hermes itself.
        </p>
        {showFilter ? (
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter models"
            size="sm"
            className="mt-3 w-56 max-w-full"
            spellCheck={false}
            aria-label="Filter Hermes models"
          />
        ) : null}
      </div>
      <div className="py-2">
        <div className={ROW_CLASS}>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            {props.models.find((model) => model.slug === HERMES_DEFAULT_MODEL)?.name ?? "Default"}
          </span>
          <Switch
            size="sm"
            aria-label="Show Hermes default"
            checked={!hiddenModels.has(HERMES_DEFAULT_MODEL)}
            disabled={!canEditModels}
            onCheckedChange={(checked) => toggleModel(HERMES_DEFAULT_MODEL, checked)}
          />
        </div>
        {providers === null ? (
          <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
            {loading ? "Loading providers" : "Set the API URL and key above, then refresh."}
          </p>
        ) : null}
        {usable.map((provider) => {
          const providerHidden = hiddenProviders.has(provider.slug);
          const models = modelsByProvider.get(provider.slug) ?? [];
          const visible = models.filter(matches);
          if (query !== "" && visible.length === 0) return null;
          const shownCount = models.filter((model) => !hiddenModels.has(model.slug)).length;
          const open = !providerHidden && (expanded.has(provider.slug) || query !== "");
          return (
            <div key={provider.slug}>
              <div className={ROW_CLASS}>
                {groupHeader(
                  provider.slug,
                  open,
                  provider.name,
                  providerHidden ? "Hidden" : `${shownCount} of ${models.length} shown`,
                )}
                <Switch
                  size="sm"
                  aria-label={`Show ${provider.name} models`}
                  checked={!providerHidden}
                  disabled={!canEditProviders}
                  onCheckedChange={(checked) => toggleProvider(provider.slug, checked)}
                />
              </div>
              {open ? (
                <div className="pb-1">
                  {visible.length === 0 ? (
                    <p className="py-1 pr-3 pl-9 text-xs text-muted-foreground sm:pr-4 sm:pl-10">
                      No models listed yet. Refresh after Hermes reports them.
                    </p>
                  ) : null}
                  {visible.map((model) => {
                    const shown = !hiddenModels.has(model.slug);
                    return (
                      <div
                        key={model.slug}
                        className={cn(
                          "flex h-8 items-center gap-2 pr-3 pl-9 sm:pr-4 sm:pl-10",
                          !shown && "opacity-60",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                          {model.name}
                        </span>
                        <Switch
                          size="sm"
                          aria-label={`Show ${model.name}`}
                          checked={shown}
                          disabled={!canEditModels}
                          onCheckedChange={(checked) => toggleModel(model.slug, checked)}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
        {locked.length > 0 && query === "" ? (
          <div>
            <div className={ROW_CLASS}>
              {groupHeader(
                "locked",
                expanded.has("locked"),
                "Unavailable",
                `${locked.length} provider${locked.length === 1 ? "" : "s"}`,
              )}
            </div>
            {expanded.has("locked")
              ? locked.map((provider) => (
                  <div key={provider.slug} className="py-1 pr-3 pl-9 sm:pr-4 sm:pl-10">
                    <div className="text-sm text-muted-foreground">{provider.name}</div>
                    <div className="text-xs text-muted-foreground/70">{lockedReason(provider)}</div>
                  </div>
                ))
              : null}
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
