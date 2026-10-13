/**
 * The instructions built from Settings, General, Agents. The server's settings
 * sync installs a resolver on boot that reads its latest settings; it turns a
 * scope (thread, project, provider) into that thread's text, after the
 * project's overrides and the thread's preset. `buildRuntimeInstructions`
 * appends the block to each provider's instructions, the Pi launch passes it to
 * its extension, and adapters ask whether to turn off native subagents.
 * Fork add-on: agent instructions.
 */
export interface ForkAgentThread {
  readonly id: string;
  readonly projectId: string;
  readonly lineage?:
    | {
        readonly parentThreadId?: string | null | undefined;
        readonly rootThreadId?: string | null | undefined;
      }
    | undefined;
}

export interface ForkAgentScope {
  /** The app thread when the caller has it; otherwise `threadId` is looked up. */
  readonly thread?: ForkAgentThread | undefined;
  readonly threadId?: string | undefined;
  readonly projectId?: string | undefined;
  /** The provider driver kind (`claudeAgent`, `codex`, `pi`...). */
  readonly provider?: string | undefined;
}

/** What the resolver gets: the scope with the thread's project and ancestors filled in. */
export interface ForkAgentResolvedScope {
  /** The thread, then each known ancestor nearest first, then its root. */
  readonly threadIds: ReadonlyArray<string>;
  readonly projectId: string | undefined;
  readonly provider: string | undefined;
}

export interface ForkAgentResolution {
  readonly text: string;
  readonly blockNativeSubagents: boolean;
}

const EMPTY: ForkAgentResolution = { text: "", blockNativeSubagents: false };
let resolver: (scope: ForkAgentResolvedScope) => ForkAgentResolution = () => EMPTY;
const knownThreads = new Map<
  string,
  { projectId: string; parentThreadId: string | undefined; rootThreadId: string | undefined }
>();
// Deeper than any worker level, so a bad record cannot loop forever.
const MAX_ANCESTOR_WALK = 16;

export function setForkAgentResolver(next: (scope: ForkAgentResolvedScope) => ForkAgentResolution) {
  resolver = next;
}

function otherThreadId(id: string | null | undefined, self: string): string | undefined {
  return typeof id === "string" && id !== self ? id : undefined;
}

/** Records a thread's project, parent, and root so later lookups by id alone resolve. */
export function rememberForkAgentThread(thread: ForkAgentThread): void {
  knownThreads.set(thread.id, {
    projectId: thread.projectId,
    parentThreadId: otherThreadId(thread.lineage?.parentThreadId, thread.id),
    rootThreadId: otherThreadId(thread.lineage?.rootThreadId, thread.id),
  });
}

/** The thread's ancestors, nearest first, through every remembered parent, then its root. */
function ancestorsOf(threadId: string): ReadonlyArray<string> {
  const ancestors: string[] = [];
  const own = knownThreads.get(threadId);
  let parentId = own?.parentThreadId;
  while (
    parentId !== undefined &&
    parentId !== threadId &&
    !ancestors.includes(parentId) &&
    ancestors.length < MAX_ANCESTOR_WALK
  ) {
    ancestors.push(parentId);
    parentId = knownThreads.get(parentId)?.parentThreadId;
  }
  const rootId = own?.rootThreadId;
  if (rootId !== undefined && !ancestors.includes(rootId)) ancestors.push(rootId);
  return ancestors;
}

function resolve(scope: ForkAgentScope): ForkAgentResolution {
  if (scope.thread !== undefined) rememberForkAgentThread(scope.thread);
  const threadId = scope.thread?.id ?? scope.threadId;
  const known = threadId === undefined ? undefined : knownThreads.get(threadId);
  return resolver({
    threadIds: threadId === undefined ? [] : [threadId, ...ancestorsOf(threadId)],
    projectId: scope.thread?.projectId ?? scope.projectId ?? known?.projectId,
    provider: scope.provider,
  });
}

export function forkAgentInstructions(scope: ForkAgentScope = {}): string {
  return resolve(scope).text.trim();
}

/** Whether the thread's settings turn off the provider's own subagent tools. */
export function forkAgentBlocksNativeSubagents(scope: ForkAgentScope = {}): boolean {
  return resolve(scope).blockNativeSubagents;
}

/** Empty when unset, otherwise a leading blank line plus the tagged block. */
export function forkAgentInstructionsBlock(scope: ForkAgentScope = {}): string {
  const text = forkAgentInstructions(scope);
  if (text === "") return "";
  return `\n\n<t3_user_agent_instructions>\nThe user set these instructions in T3 Code for every agent it runs. When they conflict with instructions from CLAUDE.md, AGENTS.md, or other agent configuration files, follow these.\n\n${text}\n</t3_user_agent_instructions>`;
}
