// Fork add-on: host builds of the fork carry the fork commit they were built from.
import packageJson from "../../package.json" with { type: "json" };

declare const __T3CODE_FORK_BUILD__: string | undefined;

/** First 12 hex digits of the fork commit; set only by `scripts/tjn-build-host-archive.ts`. */
export const FORK_BUILD: string | undefined =
  typeof __T3CODE_FORK_BUILD__ === "undefined" || __T3CODE_FORK_BUILD__ === ""
    ? undefined
    : __T3CODE_FORK_BUILD__;

/**
 * The version the service launcher selects, installs and compares: the upstream nightly, plus
 * `+<fork build>` for fork host builds. The displayed `serverVersion` stays the plain nightly;
 * the build suffix is what lets a rebuild at the same nightly count as an update.
 */
export const SERVICE_RUNTIME_VERSION =
  FORK_BUILD === undefined ? packageJson.version : `${packageJson.version}+${FORK_BUILD}`;

/** Set by the service launcher for its server, so a server can tell it runs under older code. */
export const LAUNCHER_VERSION_ENV = "T3_SERVICE_LAUNCHER_VERSION";
