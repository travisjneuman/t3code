/**
 * The fork's server capability flags: the schema fields spread into upstream's
 * `ExecutionEnvironmentCapabilities`, and the values a fork server reports.
 * A flag and its value change together. Fork add-on; see
 * docs/internals/fork-add-ons.md.
 */
import * as Schema from "effect/Schema";

export const ForkCapabilityFields = {
  // fork-addons:begin export only
  /** Server answers hostBackups.list. */
  hostBackups: Schema.optionalKey(Schema.Boolean), // Fork add-on(host-backups)
  /** Server answers existingCheckout.find. */
  existingCheckout: Schema.optionalKey(Schema.Boolean), // Fork add-on(existing-checkout)
  /** existingCheckout.find takes a folder to check. */
  existingCheckoutFolder: Schema.optionalKey(Schema.Boolean), // Fork add-on(existing-checkout)
  /** Server answers threadRetention.storage and runs thread retention. */
  threadRetention: Schema.optionalKey(Schema.Boolean), // Fork add-on(thread-retention)
  // fork-addons:end
  /** The fork add-on ids this server was built with. */
  forkAddOns: Schema.optionalKey(Schema.Array(Schema.String)), // Fork add-on(core)
};

/** Written by scripts/fork-addons.ts from fork/addons.config.json. */
export const FORK_ADDONS = [
  "core",
  "web-apps",
  "other-agents",
  "hermes",
  "openbot",
  "compare-agents",
  "agent-instructions",
  "save-to-notes",
  "thread-export",
  "session-details",
  "compact-cards",
  "subagent-tree",
  "session-search",
  "maintenance-queue",
  "existing-checkout",
  "project-links",
  "thread-retention",
  "host-backups",
  "remote-pairing",
  "usage-by-model",
  "usage-pace",
  "codex-hidden-models",
  "retired-models",
  "mcp-hub",
  "multi-select-menu",
  "collapsible-details",
  "no-project-start",
  "status-colors",
  "model-brand-names",
  "renamed-hosts",
  "tailscale-https",
  "claude-release-channel",
  "removable-providers",
  "vpn-lan",
  "windows-taskkill",
  "stdio-eio",
  "bootstrap-retry",
  "clipboard-focus",
  "route-crash-escape",
  "grok-zero-usage",
  "update-wrappers",
  "telemetry-check-failure",
  "scheduled-tasks-error",
  "identity",
  "ndev-icons",
  "keychain-free-secrets",
  "upstream-sync",
  "host-releases",
  "tjn-fleet",
  "owner-policy",
] as const;

export const FORK_SERVER_CAPABILITIES = {
  // fork-addons:begin
  hostBackups: true, // Fork add-on(host-backups)
  existingCheckout: true, // Fork add-on(existing-checkout)
  existingCheckoutFolder: true, // Fork add-on(existing-checkout)
  threadRetention: true, // Fork add-on(thread-retention)
  // fork-addons:end
  forkAddOns: FORK_ADDONS, // Fork add-on(core)
} as const;
