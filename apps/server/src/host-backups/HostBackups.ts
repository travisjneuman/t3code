/**
 * Lists the backups the host tooling (`scripts/tjn-hosts.ts`) keeps under `<T3 home>/backups`
 * and the version each would restore. It applies the tooling's quick structural checks but not
 * its per-file checksums: this answers "what could I roll back to", and the tooling re-validates
 * everything before it relies on a backup. Fork add-on: host backups.
 *
 * @module host-backups/HostBackups
 */
import {
  type HostBackupEntry,
  type HostBackupKind,
  HostBackupsError,
  type HostBackupsListResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  serviceStateActiveVersion,
  serviceStateHasPendingUpdate,
} from "../cloud/serviceProtocol.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

const BACKUPS_DIR = "backups";
const STAGING_PREFIX = ".cold-staging-";
// The same names scripts/lib/tjn-hosts/remote.ts accepts.
const COLD_NAME = /^cold-(.+?)(?:-\d{8}T\d{9}Z)?$/;
const PRE_FORK_NAME = /^pre-fork-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
// Retention keeps one or two; the cap only bounds a directory someone filled by hand.
const MAX_LISTED = 50;
// State and manifest files are a few hundred bytes; anything far larger is not one of them.
const MAX_RECORD_BYTES = 256 * 1024;

const BackupManifest = Schema.Struct({
  version: Schema.String,
  environmentId: Schema.String,
  complete: Schema.Boolean,
  createdAt: Schema.optional(Schema.String),
});
const decodeBackupManifest = Schema.decodeUnknownOption(Schema.fromJsonString(BackupManifest));

export class HostBackups extends Context.Service<
  HostBackups,
  {
    readonly list: Effect.Effect<HostBackupsListResult, HostBackupsError>;
  }
>()("t3/host-backups/HostBackups") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const root = path.join(serverConfig.baseDir, BACKUPS_DIR);

  const readRecord = (filePath: string) =>
    fs.stat(filePath).pipe(
      Effect.flatMap((info) =>
        info.type === "File" && Number(info.size) <= MAX_RECORD_BYTES
          ? fs.readFileString(filePath).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none<string>()),
      ),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const isFile = (filePath: string) =>
    fs.stat(filePath).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );

  const describe = Effect.fn("host_backups.describe")(function* (
    name: string,
    environmentId: string,
  ) {
    const cold = COLD_NAME.exec(name);
    const kind: HostBackupKind = cold
      ? "cold"
      : PRE_FORK_NAME.test(name)
        ? "pre-fork"
        : "unrecognized";
    const entry = (fields: Partial<HostBackupEntry>): HostBackupEntry => ({
      name,
      kind,
      restoresVersion: null,
      createdAt: null,
      problem: null,
      ...fields,
    });
    if (kind === "unrecognized") {
      return entry({ problem: "Not a backup name the host tooling recognizes." });
    }
    const dir = path.join(root, name);
    const stateText = yield* readRecord(path.join(dir, "service-state.json"));
    const restoresVersion = Option.isSome(stateText)
      ? (serviceStateActiveVersion(stateText.value) ?? null)
      : null;
    if (Option.isNone(stateText) || restoresVersion === null) {
      return entry({ problem: "Its service state is missing or unreadable." });
    }
    if (serviceStateHasPendingUpdate(stateText.value)) {
      return entry({ restoresVersion, problem: "It records a pending update." });
    }
    if (!(yield* isFile(path.join(dir, "statev2.sqlite")))) {
      return entry({ restoresVersion, problem: "Its database copy is missing." });
    }
    if (!cold) return entry({ restoresVersion });

    if (cold[1] !== restoresVersion) {
      return entry({
        restoresVersion,
        problem: "Its name and service state disagree on the version.",
      });
    }
    const manifest = (yield* readRecord(path.join(dir, "backup.json"))).pipe(
      Option.flatMap(decodeBackupManifest),
    );
    if (
      Option.isNone(manifest) ||
      !manifest.value.complete ||
      manifest.value.version !== restoresVersion
    ) {
      return entry({ restoresVersion, problem: "Its backup record is missing or incomplete." });
    }
    const createdAt = manifest.value.createdAt ?? null;
    if (manifest.value.environmentId !== environmentId) {
      return entry({ restoresVersion, createdAt, problem: "It belongs to another environment." });
    }
    return entry({ restoresVersion, createdAt });
  });

  const list: HostBackups["Service"]["list"] = Effect.gen(function* () {
    const exists = yield* fs.exists(root);
    if (!exists) return { backups: [], stagingCount: 0 };
    const names = (yield* fs.readDirectory(root)).toSorted();
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const stagingCount = names.filter((name) => name.startsWith(STAGING_PREFIX)).length;
    const candidates = names.filter(
      (name) => !name.startsWith(STAGING_PREFIX) && !name.startsWith("."),
    );
    const backups = yield* Effect.forEach(candidates.slice(0, MAX_LISTED), (name) =>
      describe(name, environmentId),
    );
    return { backups, stagingCount };
  }).pipe(
    Effect.mapError(() => new HostBackupsError({ message: "Could not read this host's backups." })),
    Effect.withSpan("host_backups.list"),
  );

  return HostBackups.of({ list });
});

export const layer = Layer.effect(HostBackups, make);
