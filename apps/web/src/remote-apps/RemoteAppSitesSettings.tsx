import { useAtomValue } from "@effect/atom-react";
import {
  REMOTE_APP_SITE_LABELS,
  REMOTE_APP_SITE_PROVIDER_DRIVERS,
  REMOTE_APP_SITES,
  type EnvironmentId,
} from "@t3tools/contracts";

import { DRIVER_OPTIONS } from "~/components/settings/providerDriverMeta";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import { Switch } from "~/components/ui/switch";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { primaryServerProvidersAtom } from "~/state/server";

import { RemoteAppSiteIcon } from "./RemoteAppSiteIcon";
import { resolveEnabledRemoteAppSites } from "./remoteAppState";
import { useHiddenRemoteAppSites, useRemoteAppBackgroundLoad } from "./useRemoteAppSites";

const providerLabel = (driver: string): string =>
  DRIVER_OPTIONS.find((option) => option.value === driver)?.label ?? driver;

/**
 * Chooses which provider web apps the desktop surface menu lists. Sites follow
 * this machine's providers, so the section only appears on the desktop app's
 * own environment.
 */
export function RemoteAppSitesSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const { hiddenSites, setSiteHidden } = useHiddenRemoteAppSites();
  const [backgroundLoad, setBackgroundLoad] = useRemoteAppBackgroundLoad();
  if (window.desktopBridge?.remoteApps === undefined || environmentId !== primaryEnvironmentId) {
    return null;
  }
  const enabledSites = resolveEnabledRemoteAppSites(providers);

  return (
    <SettingsSection title="Web apps">
      {REMOTE_APP_SITES.map((site) => {
        const label = REMOTE_APP_SITE_LABELS[site];
        const provider = providerLabel(REMOTE_APP_SITE_PROVIDER_DRIVERS[site]);
        const providerEnabled = enabledSites.includes(site);
        return (
          <SettingsRow
            key={site}
            title={
              <span className="flex items-center gap-2">
                <RemoteAppSiteIcon site={site} className="size-4 shrink-0" />
                {label}
              </span>
            }
            description={
              providerEnabled
                ? `Shown in the app switcher while the ${provider} provider is enabled.`
                : `Enable the ${provider} provider above to show ${label} in the app switcher.`
            }
            control={
              <Switch
                aria-label={`Show ${label} in the app switcher`}
                checked={providerEnabled && !hiddenSites.includes(site)}
                disabled={!providerEnabled}
                onCheckedChange={(checked) => setSiteHidden(site, !checked)}
              />
            }
          />
        );
      })}
      <SettingsRow
        title="Load web apps in the background"
        description="Loads the web apps above after startup so switching is instant. Uses more memory."
        control={
          <Switch
            aria-label="Load web apps in the background"
            checked={backgroundLoad}
            onCheckedChange={(checked) => setBackgroundLoad(checked)}
          />
        }
      />
    </SettingsSection>
  );
}
