import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { ProviderMirrorProvider } from "../components/settings/AllEnvironmentsProviders"; // Fork add-on(all-environments-providers)
import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

function SettingsProvidersRoute() {
  const target = Route.useSearch();
  const { environment, scope, connectedEnvironments } = useSettingsScope(); // Fork add-on(all-environments-providers)
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up its providers.`
          : "Connect an environment to set up its providers."}
      </p>
    );
  }
  // Fork add-on(all-environments-providers): without one selected machine, the lead mirrors to the rest.
  const projectIdsOn = (environmentId: EnvironmentId) =>
    // Fork add-on(all-environments-providers)
    scope.kind === "project" || scope.kind === "checkout"
      ? scope.members
          .filter((member) => member.environmentId === environmentId)
          .map((member) => member.id)
      : [];
  const mirrorTargets = // Fork add-on(all-environments-providers)
    scope.kind === "environment" // Fork add-on(all-environments-providers)
      ? [] // Fork add-on(all-environments-providers)
      : connectedEnvironments // Fork add-on(all-environments-providers)
          .filter((candidate) => candidate.environmentId !== environment.environmentId) // Fork add-on(all-environments-providers)
          .map(({ environmentId, label }) => ({
            environmentId,
            label,
            projectIds: projectIdsOn(environmentId),
          })); // Fork add-on(all-environments-providers)
  return (
    <ProviderMirrorProvider
      leadId={environment.environmentId}
      leadLabel={environment.label}
      targets={mirrorTargets}
    >
      {/* Fork add-on(all-environments-providers) */}
      <ProviderSettingsPanel
        environmentId={environment.environmentId}
        {...(target.instanceId ? { instanceId: target.instanceId } : {})}
        projectIds={
          projectIdsOn(environment.environmentId) /* Fork add-on(all-environments-providers) */
        }
        scoped
      />
    </ProviderMirrorProvider> // Fork add-on(all-environments-providers)
  );
}

export const Route = createFileRoute("/_chat/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: SettingsProvidersRoute,
});
