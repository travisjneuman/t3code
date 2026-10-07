import { isRemoteAppSite, type RemoteAppSite } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

/** Whether an app shows one chat in every thread or a chat per thread. */
export type RemoteAppChatMode = "shared" | "per-thread";
/** A thread's own override of its app's chat mode. */
export type RemoteAppThreadChoice = "own" | "shared";

type SiteMap<T> = Partial<Record<RemoteAppSite, T>>;

export interface RemoteAppPanelMemoryData {
  /** Sites whose tab is added to every thread. */
  readonly pinned: readonly RemoteAppSite[];
  readonly chatMode: SiteMap<RemoteAppChatMode>;
  /** Keyed by scoped thread key. */
  readonly threadChoice: Readonly<Record<string, SiteMap<RemoteAppThreadChoice>>>;
  /** The chat each thread keeps for itself, keyed by scoped thread key. */
  readonly threadLinks: Readonly<Record<string, SiteMap<string>>>;
  /** The chat every thread on the shared mode returns to. */
  readonly sharedUrl: SiteMap<string>;
  /** The pinned app the panel reopens on when a thread with a closed panel becomes active. */
  readonly keepPanelOpen: RemoteAppSite | null;
}

interface RemoteAppPanelMemoryState extends RemoteAppPanelMemoryData {
  readonly setPinned: (site: RemoteAppSite, pinned: boolean) => void;
  readonly setChatMode: (site: RemoteAppSite, mode: RemoteAppChatMode) => void;
  readonly setThreadChoice: (
    threadKey: string,
    site: RemoteAppSite,
    choice: RemoteAppThreadChoice | null,
  ) => void;
  readonly setThreadLink: (threadKey: string, site: RemoteAppSite, url: string | null) => void;
  readonly setSharedUrl: (site: RemoteAppSite, url: string) => void;
  readonly setKeepPanelOpen: (site: RemoteAppSite | null) => void;
}

const STORAGE_KEY = "t3code:fork:remote-app-panel:v1";
// Per-thread entries are kept for the threads written most recently.
const MAX_REMEMBERED_THREADS = 500;
const MAX_URL_LENGTH = 4_096;

const EMPTY_MEMORY: RemoteAppPanelMemoryData = {
  pinned: [],
  chatMode: {},
  threadChoice: {},
  threadLinks: {},
  sharedUrl: {},
  keepPanelOpen: null,
};

/** Drops the oldest keys; object keys keep insertion order and a write re-inserts its key last. */
function keepNewest<T>(record: Record<string, T>): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= MAX_REMEMBERED_THREADS) return record;
  const next = { ...record };
  for (const key of keys.slice(0, keys.length - MAX_REMEMBERED_THREADS)) delete next[key];
  return next;
}

function withThreadValue<T>(
  record: Readonly<Record<string, SiteMap<T>>>,
  threadKey: string,
  site: RemoteAppSite,
  value: T | null,
): Readonly<Record<string, SiteMap<T>>> {
  const { [threadKey]: current, ...rest } = record;
  if (value === null && current?.[site] === undefined) return record;
  const entry: SiteMap<T> = { ...current };
  if (value === null) delete entry[site];
  else entry[site] = value;
  return Object.keys(entry).length === 0 ? rest : keepNewest({ ...rest, [threadKey]: entry });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isUrl = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_URL_LENGTH;
const isChatMode = (value: unknown): value is RemoteAppChatMode =>
  value === "shared" || value === "per-thread";
const isThreadChoice = (value: unknown): value is RemoteAppThreadChoice =>
  value === "own" || value === "shared";

function readSiteMap<T>(value: unknown, isValue: (entry: unknown) => entry is T): SiteMap<T> {
  const map: SiteMap<T> = {};
  if (!isRecord(value)) return map;
  for (const [site, entry] of Object.entries(value)) {
    if (isRemoteAppSite(site) && isValue(entry)) map[site] = entry;
  }
  return map;
}

function readThreadMap<T>(
  value: unknown,
  isValue: (entry: unknown) => entry is T,
): Record<string, SiteMap<T>> {
  const map: Record<string, SiteMap<T>> = {};
  if (!isRecord(value)) return map;
  for (const [threadKey, entry] of Object.entries(value)) {
    const sites = readSiteMap(entry, isValue);
    if (Object.keys(sites).length > 0) map[threadKey] = sites;
  }
  return keepNewest(map);
}

/** Keeps only well-formed entries of whatever was stored. */
function readPersistedMemory(value: unknown): RemoteAppPanelMemoryData {
  if (!isRecord(value)) return EMPTY_MEMORY;
  const pinned: RemoteAppSite[] = Array.isArray(value.pinned)
    ? [...new Set(value.pinned.filter(isRemoteAppSite))]
    : [];
  return {
    pinned,
    chatMode: readSiteMap(value.chatMode, isChatMode),
    threadChoice: readThreadMap(value.threadChoice, isThreadChoice),
    threadLinks: readThreadMap(value.threadLinks, isUrl),
    sharedUrl: readSiteMap(value.sharedUrl, isUrl),
    keepPanelOpen:
      isRemoteAppSite(value.keepPanelOpen) && pinned.includes(value.keepPanelOpen)
        ? value.keepPanelOpen
        : null,
  };
}

/** Which chat a thread shows for a site; with no thread, the app's own mode decides. */
export function effectiveRemoteAppChatMode(
  memory: RemoteAppPanelMemoryData,
  threadKey: string | null,
  site: RemoteAppSite,
): RemoteAppThreadChoice {
  const choice = threadKey === null ? undefined : memory.threadChoice[threadKey]?.[site];
  return choice ?? (memory.chatMode[site] === "per-thread" ? "own" : "shared");
}

/**
 * Pinned apps, chat modes, and the chat each thread last showed, so the one
 * live page per app can be pointed at the right chat as threads change.
 */
export const useRemoteAppPanelMemory = create<RemoteAppPanelMemoryState>()(
  persist(
    (set) => ({
      ...EMPTY_MEMORY,
      setPinned: (site, pinned) =>
        set((state) => {
          if (state.pinned.includes(site) === pinned) return state;
          return pinned
            ? { pinned: [...state.pinned, site] }
            : {
                pinned: state.pinned.filter((entry) => entry !== site),
                keepPanelOpen: state.keepPanelOpen === site ? null : state.keepPanelOpen,
              };
        }),
      setChatMode: (site, mode) =>
        set((state) =>
          (state.chatMode[site] ?? "shared") === mode
            ? state
            : { chatMode: { ...state.chatMode, [site]: mode } },
        ),
      setThreadChoice: (threadKey, site, choice) =>
        set((state) => {
          const threadChoice = withThreadValue(state.threadChoice, threadKey, site, choice);
          return threadChoice === state.threadChoice ? state : { threadChoice };
        }),
      setThreadLink: (threadKey, site, url) =>
        set((state) => {
          if (url !== null && state.threadLinks[threadKey]?.[site] === url) return state;
          const threadLinks = withThreadValue(state.threadLinks, threadKey, site, url);
          return threadLinks === state.threadLinks ? state : { threadLinks };
        }),
      setSharedUrl: (site, url) =>
        set((state) =>
          state.sharedUrl[site] === url ? state : { sharedUrl: { ...state.sharedUrl, [site]: url } },
        ),
      setKeepPanelOpen: (site) =>
        set((state) => (state.keepPanelOpen === site ? state : { keepPanelOpen: site })),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state): RemoteAppPanelMemoryData => ({
        pinned: state.pinned,
        chatMode: state.chatMode,
        threadChoice: state.threadChoice,
        threadLinks: state.threadLinks,
        sharedUrl: state.sharedUrl,
        keepPanelOpen: state.keepPanelOpen,
      }),
      merge: (persisted, current) => ({ ...current, ...readPersistedMemory(persisted) }),
    },
  ),
);
