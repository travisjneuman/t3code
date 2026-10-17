// Fork add-on: on macOS the desktop encrypts its saved connection secrets with a key
// file in the T3 home instead of the keychain. Fork builds are ad-hoc signed, so the
// keychain trusts each build by its code hash and asks for the password after every
// update. The key sits beside the server's own secrets, guarded the same way (0700
// directory, 0600 file).
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

// Electron's macOS ciphertext starts with "v10", so the two formats never collide.
const MAGIC = Buffer.from("t3f1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HEADER_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES;

const isFileCiphertext = (value: Uint8Array) =>
  value.length >= HEADER_BYTES && MAGIC.equals(value.subarray(0, MAGIC.length));

const encrypt = (key: Uint8Array, value: string): Uint8Array => {
  const iv = NodeCrypto.randomBytes(IV_BYTES);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
};

const decrypt = (key: Uint8Array, value: Uint8Array): string => {
  const iv = value.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = value.subarray(MAGIC.length + IV_BYTES, HEADER_BYTES);
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(value.subarray(HEADER_BYTES)), decipher.final()]).toString(
    "utf8",
  );
};

const make = Effect.gen(function* () {
  const upstream = yield* ElectronSafeStorage.make;
  if ((yield* HostProcess.Platform) !== "darwin") return upstream;

  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const directory = path.join(environment.stateDir, "desktop-secrets");
  const keyPath = path.join(directory, "safe-storage-key.bin");

  const createKey = Effect.gen(function* () {
    const key = NodeCrypto.randomBytes(KEY_BYTES);
    const tempPath = `${keyPath}.${yield* crypto.randomUUIDv4()}.tmp`;
    yield* Effect.gen(function* () {
      yield* fileSystem.writeFile(tempPath, key, { mode: 0o600 });
      yield* fileSystem.rename(tempPath, keyPath);
    }).pipe(Effect.tapError(() => fileSystem.remove(tempPath).pipe(Effect.ignore)));
    return key;
  });

  let cachedKey: Uint8Array | undefined;
  const loadKey = Effect.gen(function* () {
    if (cachedKey !== undefined) return cachedKey;
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.chmod(directory, 0o700);
    const key = yield* fileSystem
      .readFile(keyPath)
      .pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound" ? createKey : Effect.fail(cause),
        ),
      );
    if (key.length !== KEY_BYTES) {
      return yield* Effect.fail(new Error(`${keyPath} is not a ${KEY_BYTES}-byte key.`));
    }
    yield* fileSystem.chmod(keyPath, 0o600);
    cachedKey = key;
    return key;
  });

  return ElectronSafeStorage.ElectronSafeStorage.of({
    isEncryptionAvailable: Effect.succeed(true),
    encryptString: (value) =>
      loadKey.pipe(
        Effect.flatMap((key) => Effect.try(() => encrypt(key, value))),
        Effect.mapError(
          (cause) => new ElectronSafeStorage.ElectronSafeStorageEncryptError({ cause }),
        ),
      ),
    // Secrets written before this add-on still decrypt through the keychain, once,
    // and their stores rewrite them in this format.
    decryptString: (value) =>
      isFileCiphertext(value)
        ? loadKey.pipe(
            Effect.flatMap((key) => Effect.try(() => decrypt(key, value))),
            Effect.mapError(
              (cause) => new ElectronSafeStorage.ElectronSafeStorageDecryptError({ cause }),
            ),
          )
        : upstream.decryptString(value),
    needsReencryption: (value) => !isFileCiphertext(value),
    selectedStorageBackend: upstream.selectedStorageBackend,
  });
});

export const layer = Layer.effect(ElectronSafeStorage.ElectronSafeStorage, make);
