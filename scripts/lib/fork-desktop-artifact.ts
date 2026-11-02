// The fork's pieces of the desktop artifact build, imported once by
// scripts/build-desktop-artifact.ts as `Fork`.
// fork-addons:begin export only
export {
  forkAppScheme, // Fork add-on(identity)
  REMOTE_APP_DISTRIBUTION, // Fork add-on(identity)
} from "../../apps/desktop/src/remote-apps/RemoteAppDistribution.ts";
export { withCheckoutBuildLock } from "./fork-checkout-build-lock.ts"; // Fork add-on(upstream-sync)
// fork-addons:end
