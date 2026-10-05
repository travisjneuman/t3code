/**
 * "Open in <app>" for a listed session: opens the app the session runs in on
 * that session, on the server's machine, where the session lives. Claude
 * desktop opens `claude://code/continue?session=local_<id>` (its own id for
 * the session, from claudeDesktopArchive), the Codex app opens
 * `codex://threads/<id>`. Sessions from a terminal or an editor have no such
 * link. Fork add-on; see docs/internals/external-sessions.md.
 *
 * @module external-sessions/openInOrigin
 */
import { ExternalSessionError, externalSessionOpensInOrigin } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ExternalLauncher from "../process/externalLauncher.ts";
import type { ClaudeDesktopArchive } from "./claudeDesktopArchive.ts";

// What each app's link handler accepts; anything else is never put in a URL.
const CLAUDE_LOCAL_ID = /^local_[A-Za-z0-9-]{1,64}$/;
const CODEX_THREAD_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface OriginSession {
  readonly driver: string;
  readonly origin: string | null;
  readonly sessionId: string;
}

export const make = (claudeDesktopArchive: ClaudeDesktopArchive) =>
  Effect.gen(function* () {
    const launcher = yield* ExternalLauncher.ExternalLauncher;

    const originUrl = (session: OriginSession) =>
      Effect.gen(function* () {
        if (!externalSessionOpensInOrigin(session)) return null;
        if (session.driver === "codex") {
          return CODEX_THREAD_ID.test(session.sessionId)
            ? `codex://threads/${session.sessionId}`
            : null;
        }
        const localId = yield* claudeDesktopArchive.localSessionId(session.sessionId);
        return localId !== null && CLAUDE_LOCAL_ID.test(localId)
          ? `claude://code/continue?session=${localId}`
          : null;
      });

    const openInOrigin = Effect.fn("ExternalSessions.openInOrigin")(function* (
      session: OriginSession,
    ) {
      const url = yield* originUrl(session);
      if (url === null) {
        return yield* new ExternalSessionError({
          message: "The app this session runs in can't be opened on it.",
        });
      }
      yield* launcher
        .launchBrowser(url)
        .pipe(
          Effect.mapError(
            (cause) => new ExternalSessionError({ message: "The app could not be opened.", cause }),
          ),
        );
      return {};
    });

    return { openInOrigin };
  });
