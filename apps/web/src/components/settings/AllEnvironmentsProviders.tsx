/**
 * Fork add-on(all-environments-providers): Settings → Providers with "All environments" selected
 * edits one lead environment and mirrors each change to every other connected environment that
 * has the same provider instance with the same driver.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { resolveModelPreferences } from "@t3tools/shared/serverSettings";
import type * as Duration from "effect/Duration";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, use, type ReactNode } from "react";

import { getClientSettings, prepareModelPreferencesPatch } from "../../hooks/useSettings";
import { useQueuedProviderUpdate } from "../../maintenance-queue/useQueuedUpdate";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { environmentSession, readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  isProviderSettingsUpdateCandidate,
  isProviderUpdateActive,
} from "../ProviderUpdateLaunchNotification.logic";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { getProviderVersionLabel } from "./providerStatus";
import { backgroundActivityOverrideSettings } from "./SettingsPanels.logic";
import { buildProviderInstanceOverridePatch } from "./ProviderSettingsPanel.logic";
import { SettingsRow } from "./settingsLayout";

export interface ProviderMirrorTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projectIds: readonly ProjectId[];
}

// Paths, launch arguments, credentials and env vars belong to one machine.
const HOST_SPECIFIC_KEYS: ReadonlySet<string> = new Set([
  "environment",
  "binaryPath",
  "homePath",
  "shadowHomePath",
  "launchArgs",
  "apiKey",
  "executablePath",
  "cwd",
]);

type PlainRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): PlainRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as PlainRecord)
    : {};
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function changedKeys(previous: PlainRecord, next: PlainRecord): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])].filter(
    (key) => !HOST_SPECIFIC_KEYS.has(key) && !same(previous[key], next[key]),
  );
}

function applyChanges(base: PlainRecord, previous: PlainRecord, next: PlainRecord): PlainRecord {
  const result: Record<string, unknown> = { ...base };
  for (const key of changedKeys(previous, next)) {
    if (next[key] === undefined) delete result[key];
    else result[key] = next[key];
  }
  return result;
}

/** Applies only what the user changed on the lead, keeping the target's machine-specific values. */
function mirrorInstanceConfig(
  target: ProviderInstanceConfig,
  previous: ProviderInstanceConfig,
  next: ProviderInstanceConfig,
): ProviderInstanceConfig | null {
  const { config: previousConfig, ...previousTop } = previous;
  const { config: nextConfig, ...nextTop } = next;
  const { config: targetConfig, ...targetTop } = target;
  const configChanges = changedKeys(asRecord(previousConfig), asRecord(nextConfig));
  const config =
    configChanges.length > 0
      ? applyChanges(asRecord(targetConfig), asRecord(previousConfig), asRecord(nextConfig))
      : targetConfig;
  const result = {
    ...applyChanges(targetTop, previousTop, nextTop),
    ...(config === undefined ? {} : { config }),
    driver: target.driver,
  } as ProviderInstanceConfig;
  return same(result, target) ? null : result;
}

// A cold session has no grants yet; the server still authorizes the request.
function mayUse(environmentId: EnvironmentId, scope: Parameters<typeof readEnvironmentScope>[1]) {
  const session = appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId));
  return session._tag === "Initial" || readEnvironmentScope(environmentId, scope);
}

interface TargetInstance {
  readonly target: ProviderMirrorTarget;
  readonly settings: ServerSettings;
  readonly instance: ProviderInstanceConfig;
  readonly explicit: boolean;
  readonly live: ServerProvider | undefined;
}

function findInstance(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  settings: ServerSettings | null,
  providers: ReadonlyArray<ServerProvider> | null,
) {
  if (!settings) return null;
  const explicit = settings.providerInstances?.[instanceId];
  const live = providers?.find((provider) => provider.instanceId === instanceId);
  const driver = explicit?.driver ?? live?.driver;
  if (driver === undefined) return null;
  return { environmentId, settings, instance: explicit ?? { driver }, explicit: !!explicit, live };
}

function readInstance(environmentId: EnvironmentId, instanceId: ProviderInstanceId) {
  return findInstance(
    environmentId,
    instanceId,
    appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId)),
    appAtomRegistry.get(serverEnvironment.providersValueAtom(environmentId)),
  );
}

function targetsWith(
  targets: readonly ProviderMirrorTarget[],
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
): TargetInstance[] {
  return targets.flatMap((target) => {
    const found = readInstance(target.environmentId, instanceId);
    return found && found.instance.driver === driver ? [{ ...found, target }] : [];
  });
}

function modelPreferencesFor(settings: ServerSettings, instanceId: ProviderInstanceId) {
  const resolved = resolveModelPreferences(settings, getClientSettings());
  const preferences = resolved.providerModelPreferences[instanceId];
  return {
    hidden: preferences?.hiddenModels ?? [],
    order: preferences?.modelOrder ?? [],
    favorites: resolved.favorites
      .filter((favorite) => favorite.provider === instanceId)
      .map((favorite) => favorite.model),
  };
}

function listChanges(current: ReadonlyArray<string>, desired: ReadonlyArray<string>) {
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);
  return [...new Set([...current, ...desired])]
    .filter((model) => currentSet.has(model) !== desiredSet.has(model))
    .map((model) => ({ model, on: desiredSet.has(model) }));
}

/** The model preference patch that makes the target match the lead for one instance. */
function alignModelPreferencesPatch(
  lead: ServerSettings,
  target: ServerSettings,
  instanceId: ProviderInstanceId,
): ServerSettingsPatch | null {
  const from = modelPreferencesFor(lead, instanceId);
  const to = modelPreferencesFor(target, instanceId);
  const hidden = listChanges(to.hidden, from.hidden);
  const favorites = listChanges(to.favorites, from.favorites);
  const patch: ServerSettingsPatch = {
    ...(hidden.length > 0
      ? {
          setModelsHidden: hidden.map(({ model, on }) => ({
            provider: instanceId,
            model,
            hidden: on,
          })),
        }
      : {}),
    ...(favorites.length > 0
      ? {
          setModelFavorites: favorites.map(({ model, on }) => ({
            provider: instanceId,
            model,
            favorite: on,
          })),
        }
      : {}),
    ...(!same(from.order, to.order)
      ? { setProviderModelOrder: { provider: instanceId, modelOrder: from.order } }
      : {}),
  };
  return Object.keys(patch).length > 0 ? patch : null;
}

function filterModelPreferencesPatch(
  patch: ServerSettingsPatch,
  keep: (instanceId: ProviderInstanceId) => boolean,
): ServerSettingsPatch | null {
  const hidden = patch.setModelsHidden?.filter((entry) => keep(entry.provider)) ?? [];
  const favorites = patch.setModelFavorites?.filter((entry) => keep(entry.provider)) ?? [];
  const order = patch.setProviderModelOrder;
  const next: ServerSettingsPatch = {
    ...(hidden.length > 0 ? { setModelsHidden: hidden } : {}),
    ...(favorites.length > 0 ? { setModelFavorites: favorites } : {}),
    ...(order && keep(order.provider) ? { setProviderModelOrder: order } : {}),
  };
  return Object.keys(next).length > 0 ? next : null;
}

function installStateAtom(environmentId: EnvironmentId, instanceId: ProviderInstanceId) {
  return serverEnvironment.providerInstallState({ environmentId, input: { instanceId } });
}

/** Antigravity's managed runtime is behind the published one, or missing on an enabled instance. */
function runtimeNeedsInstall(found: {
  readonly instance: ProviderInstanceConfig;
  readonly live: ServerProvider | undefined;
  readonly install: {
    readonly phase: string;
    readonly version: string | null;
    readonly installedVersion: string | null;
  } | null;
}): boolean {
  const { instance, live, install } = found;
  if (!live?.setup?.canInstall || install === null) return false;
  if (
    install.phase === "downloading" ||
    install.phase === "extracting" ||
    install.phase === "verifying"
  ) {
    return false;
  }
  const binaryPath = asRecord(instance.config).binaryPath;
  if (typeof binaryPath === "string" && binaryPath.trim().length > 0) return false;
  if (install.installedVersion !== null) {
    return install.version !== null && install.version !== install.installedVersion;
  }
  return !live.installed && resolveProviderInstanceEnabled(instance);
}

function readInstallState(environmentId: EnvironmentId, instanceId: ProviderInstanceId) {
  return AsyncResult.getOrElse(
    appAtomRegistry.get(installStateAtom(environmentId, instanceId)),
    () => null,
  );
}

async function outcome<A, E>(
  label: string,
  run: () => Promise<AtomCommandResult<A, E>>,
): Promise<string[]> {
  const result = await run().catch(() => null);
  const failed =
    result === null || (result._tag === "Failure" && !isAtomCommandInterrupted(result));
  return failed ? [label] : [];
}

function reportOutcomes(title: string, jobs: ReadonlyArray<Promise<string[]>>) {
  if (jobs.length === 0) return;
  void Promise.all(jobs).then((results) => {
    const failed = results.flat();
    if (failed.length === 0) return;
    toastManager.add({
      type: "warning",
      title,
      description: `Could not change ${failed.join(", ")}. Select that environment above to change it there.`,
    });
  });
}

function useCreateProviderMirror(
  leadId: EnvironmentId,
  leadLabel: string,
  targets: readonly ProviderMirrorTarget[],
) {
  const commandOptions = { reportFailure: false, reportDefect: false };
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, commandOptions);
  const mutateInstance = useAtomCommand(serverEnvironment.mutateProviderInstance, commandOptions);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, commandOptions);
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, commandOptions);
  const updateProvider = useQueuedProviderUpdate(serverEnvironment.updateProvider);

  const writable = (instances: TargetInstance[]) =>
    instances.filter(({ target }) => mayUse(target.environmentId, AuthSettingsWriteScope));
  const upsert = (
    found: TargetInstance,
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  ) =>
    outcome(found.target.label, () =>
      mutateInstance({
        environmentId: found.target.environmentId,
        input: {
          patch: {},
          providerInstanceMutation: { operation: "upsert", instanceId, instance },
        },
      }),
    );
  const saveModelPreferences = (
    target: ProviderMirrorTarget,
    settings: ServerSettings,
    patch: ServerSettingsPatch,
  ) =>
    outcome(target.label, () =>
      prepareModelPreferencesPatch(settings, patch).then((prepared) =>
        saveSettings({ environmentId: target.environmentId, input: { patch: prepared } }),
      ),
    );
  const leadDriver = (instanceId: ProviderInstanceId) =>
    readInstance(leadId, instanceId)?.instance.driver;

  const runtimeInstallJobs = (
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
    includeLead: boolean,
  ) =>
    targetsWith(
      includeLead
        ? [{ environmentId: leadId, label: leadLabel, projectIds: [] }, ...targets]
        : targets,
      instanceId,
      driver,
    )
      .filter(({ target }) => mayUse(target.environmentId, AuthProvidersManageScope))
      .filter((found) =>
        runtimeNeedsInstall({
          ...found,
          install: readInstallState(found.target.environmentId, instanceId),
        }),
      )
      .map((found) =>
        outcome(found.target.label, () =>
          startInstall({ environmentId: found.target.environmentId, input: { instanceId } }),
        ),
      );
  const providerUpdateJobs = (instanceId: ProviderInstanceId, driver: ProviderDriverKind) =>
    targetsWith(targets, instanceId, driver)
      .filter(({ target }) => mayUse(target.environmentId, AuthProvidersManageScope))
      .flatMap(({ target, live }) =>
        live && isProviderSettingsUpdateCandidate(live) && !isProviderUpdateActive(live)
          ? [
              outcome(target.label, () =>
                updateProvider({
                  environmentId: target.environmentId,
                  input: { provider: live.driver, instanceId },
                }),
              ),
            ]
          : [],
      );

  return {
    leadId,
    leadLabel,
    targets,
    /** Labels of the other environments that have this instance. */
    labelsWith: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) =>
      targetsWith(targets, instanceId, driver).map(({ target }) => target.label),
    instance: (
      instanceId: ProviderInstanceId,
      previous: ProviderInstanceConfig,
      next: ProviderInstanceConfig,
    ) => {
      reportOutcomes(
        "Provider not changed everywhere",
        writable(targetsWith(targets, instanceId, next.driver)).flatMap((found) => {
          const mirrored = mirrorInstanceConfig(found.instance, previous, next);
          return mirrored ? [upsert(found, instanceId, mirrored)] : [];
        }),
      );
    },
    remove: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => {
      reportOutcomes(
        "Provider not removed everywhere",
        writable(targetsWith(targets, instanceId, driver))
          .filter((found) => found.explicit)
          .map((found) =>
            outcome(found.target.label, () =>
              mutateInstance({
                environmentId: found.target.environmentId,
                input: { patch: {}, providerInstanceMutation: { operation: "remove", instanceId } },
              }),
            ),
          ),
      );
    },
    modelPreferences: (patch: ServerSettingsPatch) => {
      reportOutcomes(
        "Model preferences not saved everywhere",
        targets.flatMap((target) => {
          if (!mayUse(target.environmentId, AuthSettingsWriteScope)) return [];
          const settings = appAtomRegistry.get(
            serverEnvironment.settingsValueAtom(target.environmentId),
          );
          if (!settings) return [];
          const filtered = filterModelPreferencesPatch(patch, (instanceId) => {
            const driver = leadDriver(instanceId);
            return (
              driver !== undefined &&
              readInstance(target.environmentId, instanceId)?.instance.driver === driver
            );
          });
          return filtered ? [saveModelPreferences(target, settings, filtered)] : [];
        }),
      );
    },
    projectOverride: (
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
      value: boolean | undefined,
    ) => {
      reportOutcomes(
        "Project override not saved everywhere",
        writable(targetsWith(targets, instanceId, driver))
          .filter(({ target }) => target.projectIds.length > 0)
          .map(({ target, settings }) =>
            outcome(target.label, () =>
              saveSettings({
                environmentId: target.environmentId,
                input: {
                  patch: {
                    projectSettingsOverrides: buildProviderInstanceOverridePatch(
                      settings,
                      target.projectIds,
                      instanceId,
                      value,
                    ),
                  },
                },
              }),
            ),
          ),
      );
    },
    healthInterval: (interval: Duration.Duration | undefined) => {
      reportOutcomes(
        "Health check interval not saved everywhere",
        targets.flatMap((target) => {
          if (!mayUse(target.environmentId, AuthSettingsWriteScope)) return [];
          const settings = appAtomRegistry.get(
            serverEnvironment.settingsValueAtom(target.environmentId),
          );
          if (!settings) return [];
          const patch = backgroundActivityOverrideSettings(
            settings.backgroundActivity,
            resolveServerBackgroundActivitySettings(settings),
            { providerHealthRefreshInterval: interval },
          );
          return [
            outcome(target.label, () =>
              saveSettings({ environmentId: target.environmentId, input: { patch } }),
            ),
          ];
        }),
      );
    },
    refresh: () => {
      for (const target of targets) {
        if (!mayUse(target.environmentId, AuthOrchestrationReadScope)) continue;
        void refreshProviders({
          environmentId: target.environmentId,
          input: { refreshModels: true, reloadSecrets: true },
        });
      }
    },
    providerUpdate: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => {
      reportOutcomes("Provider not updated everywhere", providerUpdateJobs(instanceId, driver));
    },
    /** The lead's own button already started its install unless `includeLead` asks for it. */
    runtimeInstall: (
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
      includeLead = false,
    ) => {
      reportOutcomes(
        "Runtime not updated everywhere",
        runtimeInstallJobs(instanceId, driver, includeLead),
      );
    },
    /** Makes every other environment match the lead's on/off state and model preferences. */
    align: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => {
      const lead = readInstance(leadId, instanceId);
      if (!lead) return;
      const enabled = resolveProviderInstanceEnabled(lead.instance);
      reportOutcomes(
        "Provider not matched everywhere",
        writable(targetsWith(targets, instanceId, driver)).flatMap((found) => [
          ...(resolveProviderInstanceEnabled(found.instance) !== enabled
            ? [upsert(found, instanceId, { ...found.instance, enabled })]
            : []),
          ...((patch) =>
            patch ? [saveModelPreferences(found.target, found.settings, patch)] : [])(
            alignModelPreferencesPatch(lead.settings, found.settings, instanceId),
          ),
        ]),
      );
    },
  };
}

export type ProviderMirror = ReturnType<typeof useCreateProviderMirror>;

const ProviderMirrorContext = createContext<ProviderMirror | null>(null);

export function ProviderMirrorProvider({
  leadId,
  leadLabel,
  targets,
  children,
}: {
  readonly leadId: EnvironmentId;
  readonly leadLabel: string;
  readonly targets: readonly ProviderMirrorTarget[];
  readonly children: ReactNode;
}) {
  const mirror = useCreateProviderMirror(leadId, leadLabel, targets);
  return (
    <ProviderMirrorContext value={targets.length > 0 ? mirror : null}>
      {children}
    </ProviderMirrorContext>
  );
}

/** Null unless Settings → Providers is showing All environments; only the lead's view mirrors. */
export function useProviderMirror(environmentId: EnvironmentId | undefined): ProviderMirror | null {
  const mirror = use(ProviderMirrorContext);
  return mirror?.leadId === environmentId ? mirror : null;
}

export function modelPreferencesScopeNote(mirrored: boolean): string {
  return mirrored
    ? "Hiding, showing, reordering and favoriting models apply on every connected environment with this provider."
    : "Model preferences and custom models are saved on the selected environment. Choose All environments above to change them everywhere.";
}

interface EnvironmentStatus {
  readonly label: string;
  readonly enabled: boolean;
  readonly version: string | null;
  readonly update: "available" | "running" | null;
  readonly differs: readonly string[];
}

// One derived string per editor keeps status pushes that restamp checkedAt from re-rendering.
const providerStatusesAtom = Atom.family((key: string) => {
  const { leadId, leadLabel, instanceId, targets } = JSON.parse(key) as {
    leadId: EnvironmentId;
    leadLabel: string;
    instanceId: ProviderInstanceId;
    targets: ReadonlyArray<{ environmentId: EnvironmentId; label: string }>;
  };
  return Atom.make((get): string => {
    const read = (environmentId: EnvironmentId) =>
      findInstance(
        environmentId,
        instanceId,
        get(serverEnvironment.settingsValueAtom(environmentId)),
        get(serverEnvironment.providersValueAtom(environmentId)),
      );
    const lead = read(leadId);
    if (!lead) return "[]";
    const statusOf = (
      environmentId: EnvironmentId,
      label: string,
      found: NonNullable<ReturnType<typeof read>>,
    ): EnvironmentStatus => {
      const install =
        found.live?.driver === "antigravity"
          ? AsyncResult.getOrElse(get(installStateAtom(environmentId, instanceId)), () => null)
          : null;
      const live = found.live;
      const running = live !== undefined && isProviderUpdateActive(live);
      const available =
        (live !== undefined && isProviderSettingsUpdateCandidate(live)) ||
        runtimeNeedsInstall({ ...found, install });
      const enabled = resolveProviderInstanceEnabled(found.instance);
      const differs =
        environmentId === leadId
          ? []
          : [
              ...(enabled !== resolveProviderInstanceEnabled(lead.instance) ? ["on/off"] : []),
              ...(alignModelPreferencesPatch(lead.settings, found.settings, instanceId)
                ? ["models"]
                : []),
            ];
      return {
        label,
        enabled,
        version: install?.installedVersion ?? live?.version ?? null,
        update: running ? "running" : available ? "available" : null,
        differs,
      };
    };
    const statuses = [
      statusOf(leadId, leadLabel, lead),
      ...targets.flatMap((target) => {
        const found = read(target.environmentId);
        return found && found.instance.driver === lead.instance.driver
          ? [statusOf(target.environmentId, target.label, found)]
          : [];
      }),
    ];
    return JSON.stringify(statuses);
  });
});

function describeStatus(status: EnvironmentStatus): string {
  return [
    status.enabled ? "On" : "Off",
    status.version ? getProviderVersionLabel(status.version) : null,
    status.update === "running"
      ? "updating"
      : status.update === "available"
        ? "update available"
        : null,
    status.differs.length > 0 ? `${status.differs.join(" and ")} differ` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Where this provider runs, where it differs from the lead, and one-click fixes for both. */
export function AllEnvironmentsProviderSummary({
  mirror,
  instanceId,
  driver,
  readOnly,
  onUpdateLead,
}: {
  readonly mirror: ProviderMirror;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly readOnly: boolean;
  readonly onUpdateLead: (() => void) | undefined;
}) {
  const leadLabel = mirror.leadLabel;
  const key = JSON.stringify({
    leadId: mirror.leadId,
    leadLabel,
    instanceId,
    targets: mirror.targets.map(({ environmentId, label }) => ({ environmentId, label })),
  });
  const statuses = JSON.parse(useAtomValue(providerStatusesAtom(key))) as EnvironmentStatus[];
  if (statuses.length < 2) {
    return (
      <SettingsRow
        title="All environments"
        description={`Only ${leadLabel} has this provider, so changes here apply there.`}
      />
    );
  }
  const drift = statuses.some((status) => status.differs.length > 0);
  const updatable = statuses.some((status) => status.update === "available");
  return (
    <SettingsRow
      title="All environments"
      description={`Changes here apply on every environment listed. Paths, launch arguments, keys and sign-in stay per machine. Values shown are from ${leadLabel}.`}
      status={
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {statuses.map((status) => (
            <li
              key={status.label}
              className={status.differs.length > 0 ? "text-warning" : undefined}
            >
              <span className="text-foreground">{status.label}</span>: {describeStatus(status)}
            </li>
          ))}
        </ul>
      }
      control={
        readOnly ? undefined : (
          <div className="flex shrink-0 flex-col gap-2">
            {drift ? (
              <Button size="xs" variant="outline" onClick={() => mirror.align(instanceId, driver)}>
                Match {leadLabel} everywhere
              </Button>
            ) : null}
            {updatable ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  if (driver === "antigravity") mirror.runtimeInstall(instanceId, driver, true);
                  // The lead's own update already mirrors to the other environments.
                  if (onUpdateLead) onUpdateLead();
                  else mirror.providerUpdate(instanceId, driver);
                }}
              >
                Update everywhere
              </Button>
            ) : null}
          </div>
        )
      }
    />
  );
}
