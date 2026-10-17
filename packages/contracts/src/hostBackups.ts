/**
 * Host backups: the retained backups under `<T3 home>/backups` and the version each would
 * restore, read on request for Settings → Connections. Read-only; restoring stays a deliberate
 * host-side step. Fork add-on: host backups.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { AuthDiagnosticsReadScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";

export const HOST_BACKUPS_WS_METHODS = {
  list: "hostBackups.list",
} as const;

/** `unrecognized` is a directory the host tooling would refuse to treat as a backup. */
export const HostBackupKind = Schema.Literals(["cold", "pre-fork", "unrecognized"]);
export type HostBackupKind = typeof HostBackupKind.Type;

export const HostBackupEntry = Schema.Struct({
  name: Schema.String,
  kind: HostBackupKind,
  /** The service version this backup would restore; null when it cannot be read. */
  restoresVersion: Schema.NullOr(Schema.String),
  createdAt: Schema.NullOr(IsoDateTime),
  /** Why the backup looks unusable; null when the quick checks pass. */
  problem: Schema.NullOr(Schema.String),
});
export type HostBackupEntry = typeof HostBackupEntry.Type;

export const HostBackupsListResult = Schema.Struct({
  backups: Schema.Array(HostBackupEntry),
  /** Leftover `.cold-staging-*` copies of an interrupted backup. */
  stagingCount: NonNegativeInt,
});
export type HostBackupsListResult = typeof HostBackupsListResult.Type;

export class HostBackupsError extends Schema.TaggedError<HostBackupsError>()("HostBackupsError", {
  message: Schema.String,
}) {}

export const HostBackupsListRpc = Rpc.make(HOST_BACKUPS_WS_METHODS.list, {
  payload: Schema.Struct({}),
  success: HostBackupsListResult,
  error: Schema.Union([HostBackupsError, EnvironmentAuthorizationError]),
});

export const HostBackupsRpcs = [HostBackupsListRpc] as const;

/**
 * The scope each RPC needs, spread into the server's `RPC_REQUIRED_SCOPES`. Backup names and
 * versions describe the host like the process and trace diagnostics do, so they share a scope.
 */
export const HOST_BACKUPS_RPC_SCOPES = {
  [HOST_BACKUPS_WS_METHODS.list]: AuthDiagnosticsReadScope,
} as const;
