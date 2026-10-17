/**
 * Fork add-on: download size cap for pinned-runtime release assets. Assets are buffered in memory
 * before the checksum check, so a hostile or broken mirror must not be able to send unbounded
 * data.
 *
 * @module cloud/pinnedRuntimeGuards
 */
import { cliReleaseAssetSizeProblem } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { HttpClientResponse } from "effect/http";

export class ReleaseAssetTooLargeError extends Schema.TaggedError<ReleaseAssetTooLargeError>()(
  "ReleaseAssetTooLargeError",
  { problem: Schema.String },
) {
  override get message(): string {
    return this.problem;
  }
}

const declaredLength = (response: HttpClientResponse.HttpClientResponse): number | undefined => {
  const raw = response.headers["content-length"]?.trim();
  if (!raw) return undefined;
  const length = Number(raw);
  return Number.isFinite(length) && length >= 0 ? length : undefined;
};

/** Fails before any body is read when the server already declares an oversize asset. */
export const checkReleaseAssetLength = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<void, ReleaseAssetTooLargeError> => {
  const length = declaredLength(response);
  const problem = length === undefined ? undefined : cliReleaseAssetSizeProblem(length);
  return problem === undefined
    ? Effect.void
    : Effect.fail(new ReleaseAssetTooLargeError({ problem }));
};

/**
 * One counter per download. Fails the stream as soon as the running total passes the cap, so an
 * oversize body is never fully buffered.
 */
export const releaseAssetByteCap = () => {
  let received = 0;
  return (chunk: Uint8Array): Effect.Effect<void, ReleaseAssetTooLargeError> => {
    received += chunk.byteLength;
    const problem = cliReleaseAssetSizeProblem(received);
    return problem === undefined
      ? Effect.void
      : Effect.fail(new ReleaseAssetTooLargeError({ problem }));
  };
};

/**
 * `arrayBuffer` is bounded only when the declared length bounds the body: fetch decodes
 * `content-encoding` transparently, so an encoded body, or one with no length, is counted as it
 * streams instead.
 */
export const readReleaseAsset = Effect.fn("cloud.pinned_runtime.read_release_asset")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
  if (declaredLength(response) !== undefined && (!encoding || encoding === "identity")) {
    return new Uint8Array(yield* response.arrayBuffer);
  }
  const chunks = yield* response.stream.pipe(Stream.tap(releaseAssetByteCap()), Stream.runCollect);
  let size = 0;
  for (const chunk of chunks) size += chunk.byteLength;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
});

/** Keeps the cap's reason in the install error's step, where the user-facing message reads it. */
export const releaseAssetErrorStep = (step: string, cause: unknown): string =>
  cause instanceof ReleaseAssetTooLargeError ? `${step} (${cause.problem})` : step;
