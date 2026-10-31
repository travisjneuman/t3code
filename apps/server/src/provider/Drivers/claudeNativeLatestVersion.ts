import type { ClaudeSettings } from "@t3tools/contracts";
import type { ProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenance";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { resolveClaudeHomePath } from "./ClaudeHome.ts";

// `claude update` installs from this channel, which can trail the npm `latest` tag by days.
const NATIVE_RELEASES_URL = "https://downloads.claude.ai/claude-code-releases";
const LOOKUP_TIMEOUT_MS = 4_000;

const decodeChannel = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ autoUpdatesChannel: Schema.optional(Schema.Literals(["latest", "stable"])) }),
  ),
);

/** Native installs compare against the channel `claude update` reads, not npm. */
export function withClaudeNativeChannel(
  httpClient: HttpClient.HttpClient,
  config: Pick<ClaudeSettings, "homePath">,
  env: NodeJS.ProcessEnv,
) {
  return Effect.fn("withClaudeNativeChannel")(function* (
    capabilities: ProviderMaintenanceCapabilities,
  ) {
    if (capabilities.update?.lockKey !== "claudeAgent-native") return capabilities;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const channel = resolveClaudeHomePath(config, env).pipe(
      Effect.flatMap((configDir) =>
        fileSystem.readFileString(path.join(configDir, "settings.json")),
      ),
      Effect.map((text) => Option.getOrUndefined(decodeChannel(text))?.autoUpdatesChannel),
      Effect.orElseSucceed(() => undefined),
      Effect.provideService(Path.Path, path),
    );
    const lookupLatestVersion = channel.pipe(
      Effect.flatMap((name) =>
        httpClient.execute(HttpClientRequest.get(`${NATIVE_RELEASES_URL}/${name ?? "latest"}`)),
      ),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.timeoutOption(LOOKUP_TIMEOUT_MS),
      Effect.map((body) => {
        const version = Option.getOrNull(body)?.trim();
        return version && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
      }),
      Effect.orElseSucceed(() => null),
    );
    // null keeps npm out: its newer tag is not what `claude update` installs.
    return { ...capabilities, latestVersion: null, lookupLatestVersion };
  });
}
