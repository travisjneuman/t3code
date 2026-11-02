/**
 * The fork's server capability flags: the schema fields spread into upstream's
 * `ExecutionEnvironmentCapabilities`, and the values a fork server reports.
 * A flag and its value change together. Fork add-on; see
 * docs/internals/fork-add-ons.md.
 */
import * as Schema from "effect/Schema";

export const ForkCapabilityFields = {
  /** Server answers hostBackups.list. */
  hostBackups: Schema.optionalKey(Schema.Boolean), // Fork add-on(host-backups)
  /** Server answers existingCheckout.find. */
  existingCheckout: Schema.optionalKey(Schema.Boolean), // Fork add-on(existing-checkout)
  /** existingCheckout.find takes a folder to check. */
  existingCheckoutFolder: Schema.optionalKey(Schema.Boolean), // Fork add-on(existing-checkout)
  /** Server answers threadRetention.storage and runs thread retention. */
  threadRetention: Schema.optionalKey(Schema.Boolean), // Fork add-on(thread-retention)
};

export const FORK_SERVER_CAPABILITIES = {
  hostBackups: true, // Fork add-on(host-backups)
  existingCheckout: true, // Fork add-on(existing-checkout)
  existingCheckoutFolder: true, // Fork add-on(existing-checkout)
  threadRetention: true, // Fork add-on(thread-retention)
} as const;
