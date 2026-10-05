/**
 * External sessions: agent sessions running outside T3 (Claude Code, Codex,
 * Grok, Pi, Antigravity CLIs and desktop apps), streamed live from each
 * environment, plus the command that continues an idle one as a T3 thread,
 * which continued threads are running in their own agent right now, archive,
 * and handing a continued thread back to its agent. Fork add-on; the sidebar
 * section, the session route, the thread composer's banner, the thread menus,
 * and Settings › Archived read these atoms.
 */
import {
  EXTERNAL_SESSIONS_WS_METHODS,
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ExternalSessionDetails,
  type ExternalSessionEvent,
  type ExternalSessionMessage,
  type ExternalSessionSummary,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { formatModelSlugName } from "@t3tools/shared/model";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { formatProviderDriverKindLabel } from "../providerModels";
import { environmentSummaries } from "../state/presentation";

/** Transcripts keep at most this many messages client-side; older ones drop off the top. */
const MAX_TRANSCRIPT_MESSAGES = 500;

interface ExternalSessionTranscript {
  readonly summary: ExternalSessionSummary;
  readonly messages: ReadonlyArray<ExternalSessionMessage>;
  /** Older messages exist that this transcript does not hold. */
  readonly truncated: boolean;
}

/** One sidebar row: a session plus the environment it was read from. */
export interface ExternalSessionEntry {
  readonly environmentId: EnvironmentId;
  /** Set only when more than one environment reports sessions. */
  readonly environmentLabel: string | null;
  readonly session: ExternalSessionSummary;
}

/** Live session list of one environment. Old servers fail the atom once; callers ignore it. */
const externalSessionList = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:external-sessions:list",
  tag: EXTERNAL_SESSIONS_WS_METHODS.subscribeList,
});

/**
 * Live transcript of one session. Events fold into a transcript inside the
 * stream, so no append is lost to render batching and a reconnect's fresh
 * snapshot simply replaces the held state.
 */
export const externalSessionTranscript = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:external-sessions:session",
    tag: EXTERNAL_SESSIONS_WS_METHODS.subscribeSession,
    // Short, so a transcript nobody is reading stops streaming soon, while a
    // quick back-and-forth between sessions still reuses the open stream.
    idleTtlMs: 15_000,
    transform: (stream) =>
      stream.pipe(
        Stream.mapAccum(
          () => null as ExternalSessionTranscript | null,
          (
            state,
            event,
          ): readonly [
            ExternalSessionTranscript | null,
            ReadonlyArray<ExternalSessionTranscript>,
          ] => {
            const next = reduceExternalSessionTranscript(state, event);
            return [next, next === null || next === state ? [] : [next]];
          },
        ),
      ),
  },
);

/**
 * Continued threads whose session is running in its own agent right now. One
 * stream per environment, shared by every thread view; the server pushes the
 * whole set only when it changes.
 */
export const externalSessionsRunningElsewhere = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:external-sessions:running-elsewhere",
    tag: EXTERNAL_SESSIONS_WS_METHODS.subscribeRunningElsewhere,
  },
);

/**
 * Imports an idle session as a T3 thread, or returns the thread it already
 * became.
 */
export const externalSessionContinue = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:external-sessions:continue",
  tag: EXTERNAL_SESSIONS_WS_METHODS.continue,
});

/** Hides a session from the list until unarchived; Codex archives it too. */
export const externalSessionArchive = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:external-sessions:archive",
  tag: EXTERNAL_SESSIONS_WS_METHODS.archive,
});

export const externalSessionUnarchive = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:external-sessions:unarchive",
  tag: EXTERNAL_SESSIONS_WS_METHODS.unarchive,
});

/** One message on a continued thread's original agent and model (handBack.tsx). */
export const externalSessionHandBack = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:external-sessions:hand-back",
  tag: EXTERNAL_SESSIONS_WS_METHODS.handBack,
});

/** Archived sessions of one environment, newest first, for Settings › Archived. */
export const externalSessionsArchived = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:external-sessions:archived",
    tag: EXTERNAL_SESSIONS_WS_METHODS.subscribeArchived,
  },
);

/**
 * Applies one stream event. Returns the same object when nothing changed, and
 * keeps unchanged message objects, so memoized rows skip re-rendering.
 * Events before the first snapshot are ignored.
 */
function reduceExternalSessionTranscript(
  state: ExternalSessionTranscript | null,
  event: ExternalSessionEvent,
): ExternalSessionTranscript | null {
  switch (event._tag) {
    case "snapshot":
      return capTranscript({
        summary: event.summary,
        messages: event.messages,
        truncated: event.truncated,
      });
    case "summary":
      if (state === null || summariesEqual(state.summary, event.summary)) return state;
      return { ...state, summary: event.summary };
    case "append": {
      if (state === null) return state;
      const messages = upsertMessages(state.messages, event.messages);
      return messages === state.messages ? state : capTranscript({ ...state, messages });
    }
  }
}

function capTranscript(transcript: ExternalSessionTranscript): ExternalSessionTranscript {
  if (transcript.messages.length <= MAX_TRANSCRIPT_MESSAGES) return transcript;
  return {
    ...transcript,
    messages: transcript.messages.slice(-MAX_TRANSCRIPT_MESSAGES),
    truncated: true,
  };
}

/** Upserts by id: a known id is replaced in place (a reply growing), a new id is appended. */
function upsertMessages(
  current: ReadonlyArray<ExternalSessionMessage>,
  incoming: ReadonlyArray<ExternalSessionMessage>,
): ReadonlyArray<ExternalSessionMessage> {
  let next: Array<ExternalSessionMessage> | null = null;
  // Built lazily: the common case is the streamed tail growing, found without it.
  let indexById: Map<string, number> | null = null;
  for (const message of incoming) {
    const list: ReadonlyArray<ExternalSessionMessage> = next ?? current;
    const lastIndex = list.length - 1;
    let index: number;
    if (lastIndex >= 0 && list[lastIndex]?.id === message.id) {
      index = lastIndex;
    } else {
      indexById ??= new Map(list.map((entry, position) => [entry.id, position]));
      index = indexById.get(message.id) ?? -1;
    }
    if (index >= 0) {
      const existing = list[index];
      if (existing !== undefined && messagesEqual(existing, message)) continue;
      next ??= [...current];
      next[index] = message;
    } else {
      next ??= [...current];
      next.push(message);
      indexById?.set(message.id, next.length - 1);
    }
  }
  return next ?? current;
}

function messagesEqual(left: ExternalSessionMessage, right: ExternalSessionMessage): boolean {
  return (
    left.id === right.id &&
    left.role === right.role &&
    left.text === right.text &&
    left.createdAt === right.createdAt
  );
}

function summariesEqual(left: ExternalSessionSummary, right: ExternalSessionSummary): boolean {
  return (
    left.key === right.key &&
    left.driver === right.driver &&
    left.origin === right.origin &&
    left.title === right.title &&
    left.cwd === right.cwd &&
    left.model === right.model &&
    left.updatedAt === right.updatedAt &&
    left.liveness === right.liveness &&
    detailsEqual(left.details, right.details)
  );
}

function detailsEqual(
  left: ExternalSessionDetails | undefined,
  right: ExternalSessionDetails | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  const keys = Object.keys(left) as Array<keyof ExternalSessionDetails>;
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    const a = left[key];
    const b = right[key];
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((value, index) => value === b[index]);
    }
    return a === b;
  });
}

const EMPTY_ENTRIES: ReadonlyArray<ExternalSessionEntry> = [];

function entryKey(environmentId: EnvironmentId, sessionKey: string): string {
  return `${environmentId}\u0000${sessionKey}`;
}

function updatedAtMs(entry: ExternalSessionEntry): number {
  const parsed = Date.parse(entry.session.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Sessions from every connected environment, newest first. Unchanged entries
 * keep their identity and an unchanged list returns the previous array, so a
 * list push that touches one session re-renders one row.
 */
export const externalSessionEntriesAtom = Atom.make((get) => {
  const environmentIds = get(environmentSummaries.connectedEnvironmentIdsAtom);
  const sources: Array<{
    readonly environmentId: EnvironmentId;
    readonly sessions: ReadonlyArray<ExternalSessionSummary>;
  }> = [];
  for (const environmentId of environmentIds) {
    const list = Option.getOrNull(
      AsyncResult.value(get(externalSessionList({ environmentId, input: {} }))),
    );
    if (list !== null && list.sessions.length > 0) {
      sources.push({ environmentId, sessions: list.sessions });
    }
  }

  const multipleEnvironments = sources.length > 1;
  const labels = multipleEnvironments
    ? new Map(
        get(environmentSummaries.identitiesAtom).map(
          (identity) => [identity.environmentId, identity.label] as const,
        ),
      )
    : null;
  const previous = Option.getOrNull(get.self<ReadonlyArray<ExternalSessionEntry>>());
  const previousByKey = new Map(
    (previous ?? EMPTY_ENTRIES).map(
      (entry) => [entryKey(entry.environmentId, entry.session.key), entry] as const,
    ),
  );

  const next: Array<ExternalSessionEntry> = [];
  for (const { environmentId, sessions } of sources) {
    const environmentLabel = labels?.get(environmentId) ?? null;
    for (const session of sessions) {
      const prior = previousByKey.get(entryKey(environmentId, session.key));
      next.push(
        prior !== undefined &&
          prior.environmentLabel === environmentLabel &&
          summariesEqual(prior.session, session)
          ? prior
          : { environmentId, environmentLabel, session },
      );
    }
  }
  // Each server already sends its list newest first; only a merge needs a sort.
  if (multipleEnvironments) {
    const timeByEntry = new Map(next.map((entry) => [entry, updatedAtMs(entry)] as const));
    next.sort((left, right) => (timeByEntry.get(right) ?? 0) - (timeByEntry.get(left) ?? 0));
  }

  if (next.length === 0) return EMPTY_ENTRIES;
  return previous !== null &&
    previous.length === next.length &&
    next.every((entry, index) => entry === previous[index])
    ? previous
    : next;
}).pipe(Atom.withLabel("external-sessions:entries"));

/** Last path segment of a working directory, for compact labels. */
export function cwdBasename(cwd: string | null): string | null {
  if (cwd === null) return null;
  const segments = cwd.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? cwd;
}

export function externalSessionTitle(session: ExternalSessionSummary): string {
  const title = session.title.trim();
  return title.length > 0 ? title : "Untitled session";
}

export const LIVENESS_LABEL = {
  running: "Running",
  idle: "Idle",
  recent: "Inactive",
} as const satisfies Record<ExternalSessionSummary["liveness"], string>;

/** Product name of the agent, e.g. "Claude" or "Codex". */
export function externalSessionProductName(session: ExternalSessionSummary): string {
  return PROVIDER_DISPLAY_NAMES[session.driver] ?? formatProviderDriverKindLabel(session.driver);
}

/** Where the session runs, e.g. "Claude Desktop" or "Codex CLI". */
export function externalSessionOriginLabel(session: ExternalSessionSummary): string {
  const product = externalSessionProductName(session);
  return session.origin === null || session.origin.length === 0
    ? product
    : `${product} ${session.origin}`;
}

/** Compact model label for tight rows: "claude-opus-5-5" reads "Opus 5.5". */
export function shortModelLabel(model: string | null): string | null {
  if (model === null || model.trim().length === 0) return null;
  const label = formatModelSlugName(model.trim());
  return label.startsWith("Claude ") ? label.slice("Claude ".length) : label;
}

// Mode and effort values arrive in each agent's own terms; known ones read
// better spelled out, the rest are split into words.
const SETTING_LABELS: Record<string, string> = {
  xhigh: "Extra High",
  acceptEdits: "Accept edits",
  bypassPermissions: "Bypass permissions",
  dontAsk: "Don't ask",
  never: "Never ask",
  "on-request": "On request",
  "on-failure": "On failure",
  yolo: "Yolo (auto-approve)",
  "danger-full-access": "Full access",
  "workspace-write": "Workspace write",
  "read-only": "Read-only",
};

/** "bypassPermissions" reads "Bypass permissions", "high" reads "High". */
export function externalSessionSettingLabel(value: string): string {
  const known = SETTING_LABELS[value];
  if (known !== undefined) return known;
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .toLowerCase();
  return words.length === 0 ? value : `${words[0]!.toUpperCase()}${words.slice(1)}`;
}
