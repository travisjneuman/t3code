/**
 * A Hermes thread's session details, read from Hermes over HTTP whether or not
 * T3 runs the session, since Hermes keeps its own session store. Registered in
 * forkInsightsReaders.ts. Fork add-on; see docs/internals/hermes.md.
 */
import type { SessionInsights as SessionInsightsResult } from "@t3tools/contracts";
import { HermesInsights } from "@t3tools/provider-hermes/server";
import { HermesSettings } from "@t3tools/provider-hermes/settings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  DriverInsightsInput,
  DriverInsightsReader,
} from "../sessionInsights/SessionInsights.ts";

/** Hermes pages a long session's messages, so it gets longer than one live read. */
const HERMES_TIMEOUT = "30 seconds";
const decodeHermesSettings = Schema.decodeUnknownOption(HermesSettings);

const hostOfUrl = (url: string): string | undefined => {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
};

export const readHermesInsights: DriverInsightsReader = Effect.fn("HermesInsightsReader.read")(
  function* ({ providerThread, config }: DriverInsightsInput) {
    const sessionId = providerThread.nativeThreadRef?.nativeId ?? null;
    if (sessionId === null) return undefined;
    const hermesSettings = Option.getOrUndefined(decodeHermesSettings(config ?? {}));
    if (hermesSettings === undefined) return undefined;
    const read = yield* HermesInsights.read({ settings: hermesSettings, sessionId }).pipe(
      Effect.timeout(HERMES_TIMEOUT),
      Effect.catch(() =>
        Effect.logWarning("session-insights.hermes-timeout", {
          providerThreadId: providerThread.id,
        }).pipe(Effect.as(undefined)),
      ),
    );
    if (
      read === undefined ||
      (read.session === null &&
        read.context === null &&
        read.mcpServers === null &&
        read.outputs === null)
    ) {
      return undefined;
    }
    // The agent runs where Hermes runs, not on this server.
    const host = hostOfUrl(hermesSettings.apiUrl);
    const report: SessionInsightsResult = {
      providerThreadId: providerThread.id,
      instanceId: providerThread.providerInstanceId,
      driver: providerThread.driver,
      // Hermes answered for the session itself, whether or not T3 runs it now.
      live: true,
      capturedAt: DateTime.formatIso(yield* DateTime.now),
      context: read.context,
      mcpServers: read.mcpServers,
      ...(host === undefined ? {} : { host }),
      ...(read.session === null ? {} : { session: read.session }),
      outputs: read.outputs,
    };
    return report;
  },
);
