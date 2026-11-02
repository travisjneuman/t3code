import { useServerConfigs } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { SettingsRow } from "./settingsLayout";

/** Fork add-on(core): the add-ons the primary server was built with. Upstream servers send none. */
export function ForkAddOnsRow() {
  const environmentId = usePrimaryEnvironmentId();
  const serverConfigs = useServerConfigs();
  const addOns =
    environmentId === null
      ? undefined
      : serverConfigs.get(environmentId)?.environment.capabilities.forkAddOns;
  if (addOns === undefined) return null;
  return <SettingsRow title="Fork add-ons" description={addOns.join(", ")} />;
}
