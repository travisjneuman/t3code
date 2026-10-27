/**
 * Settings → Archive additions: disk use per machine, the retention settings
 * (archive settled threads, delete archived ones), and the settled threads with
 * their sizes. Settled threads come from the storage listing, not the sidebar,
 * because older ones are not loaded on a cold connect. Mounted by the archive
 * wrapper in external-sessions/ArchivedExternalSessions.tsx. Sizes include each thread's
 * subagent threads, which follow their parent. Fork add-on: thread retention.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createEnvironmentRpcQueryAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_THREAD_RETENTION_DAYS,
  DEFAULT_UNIFIED_SETTINGS,
  MAX_THREAD_RETENTION_DAYS,
  MIN_THREAD_RETENTION_DAYS,
  THREAD_RETENTION_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadRetentionStorageResult,
  type ThreadRetentionStorageThread,
} from "@t3tools/contracts";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { ScopedSwitch } from "../components/settings/ScopedSwitch";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { settingsScopeEnvironmentLabels } from "../components/settings/settingsScopeAxis";
import { searchableSetting } from "../components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { RelativeTime } from "../components/RelativeTime";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { WorkspacePageContainer } from "../components/WorkspacePageContainer";
import { connectionAtomRuntime } from "../connection/runtime";
import { useThreadActions } from "../hooks/useThreadActions";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { formatBytes } from "../lib/formatBytes";
import { useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

const threadStorageQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:thread-retention:storage",
  tag: THREAD_RETENTION_WS_METHODS.storage,
  idleTtlMs: 0,
});

const SETTLED_PAGE_SIZE = 50;

const storageQueryFor = (environmentId: EnvironmentId) =>
  threadStorageQuery({ environmentId, input: {} });

/** Every machine's storage in one atom, so a scope change never changes the hook count. */
const scopeStorageAtom = Atom.family((environmentIdsKey: string) => {
  const environmentIds = JSON.parse(environmentIdsKey) as EnvironmentId[];
  return Atom.make((get) =>
    environmentIds.map((environmentId) => {
      const result = get(storageQueryFor(environmentId));
      return {
        environmentId,
        storage: Option.getOrNull(AsyncResult.value(result)),
        failed: result._tag === "Failure",
      };
    }),
  ).pipe(Atom.withLabel(`thread-retention-scope-storage:${environmentIdsKey}`));
});

const useScopeStorage = (environmentIds: readonly EnvironmentId[]) =>
  useAtomValue(scopeStorageAtom(JSON.stringify(environmentIds)));

function useRetentionEnvironmentIds(): readonly EnvironmentId[] {
  const { scope } = useSettingsScope();
  const { environments } = useEnvironments();
  const capable = new Set(
    environments
      .filter(
        (environment) =>
          environment.serverConfig?.environment.capabilities.threadRetention === true,
      )
      .map((environment) => environment.environmentId),
  );
  return scope.environmentIds.filter((environmentId) => capable.has(environmentId));
}

function useEnvironmentLabel() {
  const { environments } = useSettingsScope();
  return (environmentId: EnvironmentId) => {
    const environment = environments.find((entry) => entry.environmentId === environmentId);
    if (!environment) return environmentId;
    const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
    return secondary ? `${primary} (${secondary})` : primary;
  };
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

const countLabel = (count: number) => (count === 1 ? "1 thread" : `${count} threads`);

const sizeLabel = (thread: ThreadRetentionStorageThread) => {
  const subagents = thread.subagentCount ?? 0;
  const size = formatBytes(thread.bytes);
  if (subagents === 0) return size;
  return `${size} · ${subagents === 1 ? "1 subagent" : `${subagents} subagents`}`;
};

const totalBytes = (storage: ThreadRetentionStorageResult) =>
  storage.databaseBytes + storage.attachmentsBytes;

export function ThreadRetentionSections() {
  const environmentIds = useRetentionEnvironmentIds();
  if (environmentIds.length === 0) return null;
  return (
    <WorkspacePageContainer className="pb-0">
      <ThreadStorageSection environmentIds={environmentIds} />
      <ThreadRetentionSettingsSection />
      <SettledThreadsSection environmentIds={environmentIds} />
    </WorkspacePageContainer>
  );
}

function ThreadStorageSection({ environmentIds }: { environmentIds: readonly EnvironmentId[] }) {
  return (
    <SettingsSection {...searchableSetting("thread-storage")}>
      {environmentIds.length > 1 ? <AllMachinesStorageRow environmentIds={environmentIds} /> : null}
      {environmentIds.map((environmentId) => (
        <MachineStorageRow key={environmentId} environmentId={environmentId} />
      ))}
    </SettingsSection>
  );
}

function AllMachinesStorageRow({ environmentIds }: { environmentIds: readonly EnvironmentId[] }) {
  const results = useScopeStorage(environmentIds);
  const loaded = results.flatMap((result) => (result.storage ? [result.storage] : []));
  const pending = loaded.length < results.length;
  return (
    <SettingsRow
      title="All machines"
      description={
        pending
          ? `Measured ${loaded.length} of ${results.length} machines so far.`
          : "T3 Code's database and attachments on every machine in this scope."
      }
      control={
        <span className="font-medium text-sm tabular-nums">
          {formatBytes(loaded.reduce((sum, storage) => sum + totalBytes(storage), 0))}
        </span>
      }
    />
  );
}

function MachineStorageRow({ environmentId }: { environmentId: EnvironmentId }) {
  const label = useEnvironmentLabel();
  const query = useEnvironmentQuery(storageQueryFor(environmentId));
  const storage = query.data;
  const settled = storage?.threads.filter((thread) => thread.state === "settled") ?? [];
  const archived = storage?.threads.filter((thread) => thread.state === "archived") ?? [];
  const description =
    storage === null
      ? (query.error ?? "Measuring…")
      : [
          `Database ${formatBytes(storage.databaseBytes)}`,
          `attachments ${formatBytes(storage.attachmentsBytes)}`,
          `settled ${formatBytes(storage.settledBytes)} (${countLabel(settled.length)})`,
          `archived ${formatBytes(storage.archivedBytes)} (${countLabel(archived.length)})`,
          `other threads ${formatBytes(storage.otherThreadsBytes)}`,
          ...(storage.deletedPendingPurgeBytes > 0
            ? [`deleted, waiting to be purged ${formatBytes(storage.deletedPendingPurgeBytes)}`]
            : []),
        ].join(" · ");
  return (
    <SettingsRow
      title={label(environmentId)}
      description={description}
      control={
        <div className="flex items-center gap-2">
          {storage ? (
            <span className="font-medium text-sm tabular-nums">
              {formatBytes(totalBytes(storage))}
            </span>
          ) : null}
          <Button size="sm" variant="outline" disabled={query.isPending} onClick={query.refresh}>
            Refresh
          </Button>
        </div>
      }
    />
  );
}

function RetentionDaysInput({
  value,
  label,
  onCommit,
}: {
  value: number;
  label: string;
  onCommit: (days: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [draftSource, setDraftSource] = useState(value);
  if (draftSource !== value) {
    setDraftSource(value);
    setDraft(String(value));
  }
  return (
    <Input
      size="sm"
      type="number"
      min={MIN_THREAD_RETENTION_DAYS}
      max={MAX_THREAD_RETENTION_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_THREAD_RETENTION_DAYS &&
          parsed <= MAX_THREAD_RETENTION_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label={label}
    />
  );
}

type RetentionKey =
  | "threadRetentionArchiveSettledAfterDays"
  | "threadRetentionDeleteArchivedAfterDays";

function RetentionRows({
  settingKey,
  searchId,
  description,
  daysTitle,
  daysDescription,
}: {
  settingKey: RetentionKey;
  searchId: "thread-retention-archive-settled" | "thread-retention-delete-archived";
  description: string;
  daysTitle: string;
  daysDescription: string;
}) {
  const days = useScopedSettings((settings) => settings[settingKey]);
  const updateSettings = useUpdateScopedSettings();
  const { title } = searchableSetting(searchId);
  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={[settingKey]}
        {...searchableSetting(searchId)}
        description={description}
        resetAction={
          days !== DEFAULT_UNIFIED_SETTINGS[settingKey] ? (
            <SettingResetButton
              label={title.toLowerCase()}
              onClick={() => updateSettings({ [settingKey]: DEFAULT_UNIFIED_SETTINGS[settingKey] })}
            />
          ) : null
        }
        control={
          <ScopedSwitch
            settingKeys={[settingKey]}
            checked={days !== null}
            onCheckedChange={(checked) =>
              updateSettings({ [settingKey]: checked ? DEFAULT_THREAD_RETENTION_DAYS : null })
            }
            aria-label={title}
          />
        }
      />
      {days !== null ? (
        <SettingsRow
          serverScoped
          settingKeys={[settingKey]}
          title={daysTitle}
          description={daysDescription}
          control={
            <RetentionDaysInput
              value={days}
              label={daysTitle}
              onCommit={(next) => updateSettings({ [settingKey]: next })}
            />
          }
        />
      ) : null}
    </>
  );
}

function ThreadRetentionSettingsSection() {
  const { scope } = useSettingsScope();
  if (scope.kind !== "all" && scope.kind !== "environment") return null;
  return (
    <SettingsSection title="Retention">
      <RetentionRows
        settingKey="threadRetentionArchiveSettledAfterDays"
        searchId="thread-retention-archive-settled"
        description="Settled threads untouched for this long move to the archive, with their subagent threads. Pinned threads and threads with running or scheduled work stay."
        daysTitle="Days settled before archiving"
        daysDescription="Counted from when the thread settled. Any new activity un-settles it."
      />
      <RetentionRows
        settingKey="threadRetentionDeleteArchivedAfterDays"
        searchId="thread-retention-delete-archived"
        description="Archived threads older than this are deleted with their subagent threads, and their history is purged from disk a day later."
        daysTitle="Days archived before deleting"
        daysDescription="Unarchive a thread to keep it."
      />
    </SettingsSection>
  );
}

function SettledThreadsSection({ environmentIds }: { environmentIds: readonly EnvironmentId[] }) {
  const { scope, groups } = useSettingsScope();
  const label = useEnvironmentLabel();
  const [limit, setLimit] = useState(SETTLED_PAGE_SIZE);
  const results = useScopeStorage(environmentIds);
  const selectedProjects =
    scope.kind === "project" || scope.kind === "checkout"
      ? new Set(scope.members.map((member) => `${member.environmentId}:${member.id}`))
      : null;
  const projectNames = new Map(
    groups.flatMap((group) =>
      group.memberProjectRefs.map(
        (member) => [`${member.environmentId}:${member.projectId}`, group.displayName] as const,
      ),
    ),
  );
  const threads = results
    .flatMap(({ environmentId, storage }) =>
      (storage?.threads ?? [])
        .filter(
          (thread) =>
            thread.state === "settled" &&
            (selectedProjects === null ||
              selectedProjects.has(`${environmentId}:${thread.projectId}`)),
        )
        .map((thread) => ({ environmentId, thread })),
    )
    .toSorted((left, right) =>
      (right.thread.settledAt ?? right.thread.updatedAt).localeCompare(
        left.thread.settledAt ?? left.thread.updatedAt,
      ),
    );
  const loading = results.some((result) => result.storage === null && !result.failed);
  const showMachine = environmentIds.length > 1;
  return (
    <SettingsSection {...searchableSetting("settled-threads")}>
      {threads.length === 0 ? (
        <SettingsRow
          title={loading ? "Loading settled threads" : "No settled threads"}
          description="Threads you or auto-settle put on the sidebar's Settled shelf appear here."
        />
      ) : (
        threads
          .slice(0, limit)
          .map(({ environmentId, thread }) => (
            <SettledThreadRow
              key={`${environmentId}:${thread.threadId}`}
              environmentId={environmentId}
              thread={thread}
              context={[
                ...(showMachine ? [label(environmentId)] : []),
                ...(selectedProjects === null
                  ? [projectNames.get(`${environmentId}:${thread.projectId}`) ?? "Unknown project"]
                  : []),
              ].join(" · ")}
            />
          ))
      )}
      {threads.length > limit ? (
        <SettingsRow
          title={`${threads.length - limit} more settled threads`}
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setLimit((current) => current + SETTLED_PAGE_SIZE)}
            >
              Show more
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function SettledThreadRow({
  environmentId,
  thread,
  context,
}: {
  environmentId: EnvironmentId;
  thread: ThreadRetentionStorageThread;
  context: string;
}) {
  const refreshStorage = useAtomRefresh(storageQueryFor(environmentId));
  const [busy, setBusy] = useState(false);
  const { unsettleThread, confirmAndDeleteThread } = useThreadActions();
  // useThreadActions.archiveThread no-ops for threads the sidebar has not loaded.
  const archive = useOrchestrationCommand(threadEnvironment.archive, { reportFailure: false });
  const threadRef = scopeThreadRef(environmentId, thread.threadId);
  const run = async (title: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    if (busy) return;
    setBusy(true);
    const result = await action();
    setBusy(false);
    reportFailure(title, result);
    if (result._tag === "Success") refreshStorage();
  };
  return (
    <SettingsRow
      title={thread.title}
      description={
        <span className="block truncate">
          {context ? `${context} · ` : null}
          Settled <RelativeTime timestamp={thread.settledAt ?? thread.updatedAt} />
          {` · ${sizeLabel(thread)}`}
        </span>
      }
      control={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run("Failed to unsettle thread", () => unsettleThread(threadRef))}
          >
            Unsettle
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run("Failed to archive thread", async () => {
                const result = await archive({
                  environmentId,
                  input: { threadId: thread.threadId },
                });
                if (result._tag === "Success") refreshArchivedThreadsForEnvironment(environmentId);
                return result;
              })
            }
          >
            Archive
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run("Failed to delete thread", () => confirmAndDeleteThread(threadRef))
            }
          >
            Delete
          </Button>
        </div>
      }
    />
  );
}

const threadsByResult = new WeakMap<
  ThreadRetentionStorageResult,
  Map<ThreadId, ThreadRetentionStorageThread>
>();

function storageThread(storage: ThreadRetentionStorageResult, threadId: ThreadId) {
  let byThread = threadsByResult.get(storage);
  if (byThread === undefined) {
    byThread = new Map(storage.threads.map((thread) => [thread.threadId, thread]));
    threadsByResult.set(storage, byThread);
  }
  return byThread.get(threadId) ?? null;
}

/**
 * Archived subagent threads are listed under their parent's row, not on their own, when the
 * parent is archived too. One archived alone still shows so it can be unarchived.
 */
export function hideArchivedSubagents<
  Thread extends Pick<OrchestrationV2ThreadShell, "id" | "lineage">,
>(threads: ReadonlyArray<Thread>): ReadonlyArray<Thread> {
  const archivedIds = new Set<string>(threads.map((thread) => thread.id));
  return threads.filter(
    (thread) =>
      thread.lineage.relationshipToParent !== "subagent" ||
      thread.lineage.parentThreadId === null ||
      !archivedIds.has(thread.lineage.parentThreadId),
  );
}

/** Page-level title over the upstream per-project archived groups. */
export function ArchivedThreadsHeading() {
  return (
    <div className="flex min-h-7 items-center px-3 sm:px-4">
      <h2 className="text-base font-semibold text-foreground">Archived threads</h2>
    </div>
  );
}

/**
 * " · 1.2 MB · 3 subagents" after an archived thread's dates, once that machine's storage has
 * been measured.
 */
export function ThreadStorageBytes({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const { environments } = useEnvironments();
  const capable =
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.environment.capabilities.threadRetention === true;
  const storage = useEnvironmentQuery(capable ? storageQueryFor(environmentId) : null).data;
  const thread = storage ? storageThread(storage, threadId) : null;
  return thread === null ? null : <>{` · ${sizeLabel(thread)}`}</>;
}
