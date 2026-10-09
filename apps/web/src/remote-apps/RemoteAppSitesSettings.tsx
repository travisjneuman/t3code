import { useAtomValue } from "@effect/atom-react";
import { REMOTE_APP_SITE_INFO, REMOTE_APP_SITES, type EnvironmentId } from "@t3tools/contracts";

import { providerClients } from "~/components/settings/providerDriverMeta";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { primaryServerProvidersAtom } from "~/state/server";

import { RemoteAppChatImportRow } from "./RemoteAppChatImportRow";
import { RemoteAppSiteIcon } from "./RemoteAppSiteIcon";
import { resolveAvailableRemoteAppSites, resolveEnabledRemoteAppSites } from "./remoteAppState";
import {
  REMOTE_APP_IDLE_UNLOAD_CHOICES,
  type RemoteAppIdleUnloadMinutes,
  useBackgroundDisabledRemoteAppSites,
  useEnabledStandaloneRemoteAppSites,
  useHiddenRemoteAppSites,
  useRemoteAppIdleUnloadMinutes,
} from "./useRemoteAppSites";

const providerLabel = (driver: string): string =>
  providerClients.definitions.find((definition) => definition.driverKind === driver)?.label ??
  driver;

const siteDescription = (
  label: string,
  driver: string | null,
  providerEnabled: boolean,
): string => {
  if (driver === null) {
    return "A web app with no T3 provider. Turn it on to show it in the app switcher.";
  }
  const provider = providerLabel(driver);
  return providerEnabled
    ? `Shown in the app switcher while the ${provider} provider is enabled.`
    : `Enable the ${provider} provider above to show ${label} in the app switcher.`;
};

const idleUnloadValue = (minutes: RemoteAppIdleUnloadMinutes): string =>
  minutes === null ? "off" : String(minutes);

const idleUnloadLabel = (minutes: RemoteAppIdleUnloadMinutes): string =>
  minutes === null ? "Off" : `${minutes / 60}h`;

/**
 * Chooses which web apps the desktop surface menu lists, which of them load
 * in the background, and how long hidden ones keep their pages. Provider
 * sites follow this machine's providers, so the section only appears on the
 * desktop app's own environment.
 */
export function RemoteAppSitesSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const { hiddenSites, setSiteHidden } = useHiddenRemoteAppSites();
  const { enabledStandaloneSites, setStandaloneSiteEnabled } = useEnabledStandaloneRemoteAppSites();
  const { backgroundDisabledSites, setSiteBackgroundDisabled } =
    useBackgroundDisabledRemoteAppSites();
  const { idleUnloadMinutes, setIdleUnloadMinutes } = useRemoteAppIdleUnloadMinutes();
  const bridge = window.desktopBridge?.remoteApps;
  if (bridge === undefined || environmentId !== primaryEnvironmentId) return null;
  const enabledSites = resolveEnabledRemoteAppSites(providers);
  const shownSites = resolveAvailableRemoteAppSites(providers, hiddenSites, enabledStandaloneSites);

  return (
    <SettingsSection title="Web apps">
      <p className="px-3 py-3 text-xs leading-normal text-muted-foreground/80 sm:px-4">
        Loading a web app in the background makes it instant to open, but each one uses about
        150–400 MB of memory.
      </p>
      {REMOTE_APP_SITES.map((site) => {
        const { label, providerDriver } = REMOTE_APP_SITE_INFO[site];
        const standalone = providerDriver === null;
        const providerEnabled = enabledSites.includes(site);
        const shown = shownSites.includes(site);
        return (
          <SettingsRow
            key={site}
            title={
              <span className="flex items-center gap-2">
                <RemoteAppSiteIcon site={site} className="size-4 shrink-0" />
                {label}
              </span>
            }
            description={siteDescription(label, providerDriver, providerEnabled)}
            control={
              <>
                <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  Background
                  <Switch
                    aria-label={`Load ${label} in the background`}
                    checked={shown && !backgroundDisabledSites.includes(site)}
                    disabled={!shown}
                    onCheckedChange={(checked) => setSiteBackgroundDisabled(site, !checked)}
                  />
                </label>
                <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  Show
                  <Switch
                    aria-label={`Show ${label} in the app switcher`}
                    checked={shown}
                    disabled={!standalone && !providerEnabled}
                    onCheckedChange={(checked) =>
                      standalone
                        ? setStandaloneSiteEnabled(site, checked)
                        : setSiteHidden(site, !checked)
                    }
                  />
                </label>
              </>
            }
          />
        );
      })}
      <SettingsRow
        title="Unload idle web apps"
        description="Frees a hidden web app's memory after it goes unopened this long. It reloads when opened."
        control={
          <Select
            value={idleUnloadValue(idleUnloadMinutes)}
            onValueChange={(value) => {
              const choice = REMOTE_APP_IDLE_UNLOAD_CHOICES.find(
                (minutes) => idleUnloadValue(minutes) === value,
              );
              if (choice !== undefined) setIdleUnloadMinutes(choice);
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-28" aria-label="Unload idle web apps">
              <SelectValue>{idleUnloadLabel(idleUnloadMinutes)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {REMOTE_APP_IDLE_UNLOAD_CHOICES.map((minutes) => (
                <SelectItem
                  hideIndicator
                  key={idleUnloadValue(minutes)}
                  value={idleUnloadValue(minutes)}
                >
                  {idleUnloadLabel(minutes)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <RemoteAppChatImportRow bridge={bridge} />
    </SettingsSection>
  );
}
