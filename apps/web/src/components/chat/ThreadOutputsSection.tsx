import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { FileDiffIcon, MinusIcon, PlusIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { cn } from "../../lib/utils";
import { useThreadOutputs } from "../../state/sessionInsights";
import { StartTruncatedPath } from "../StartTruncatedPath";
import { DiffStatLabel } from "./DiffStatLabel";
import { type OutputFile, sumOutputChanges } from "./sessionInsights.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

const OUTPUTS_INITIAL_COUNT = 8;

const OUTPUT_ROW_CLASS = cn(
  "flex h-8 w-full min-w-0 items-center rounded-lg text-sm text-foreground/80",
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
);

/** Files the thread's turns changed, newest first; each opens its diff. Fork add-on. */
export const ThreadOutputsSection = memo(function ThreadOutputsSection(props: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | undefined;
  readonly onOpenTurnDiff: ((runId: RunId, filePath?: string) => void) | undefined;
}) {
  const outputs = useThreadOutputs(props.threadRef);
  return (
    <ThreadOutputsList
      outputs={outputs}
      workspaceRoot={props.workspaceRoot}
      onOpenTurnDiff={props.onOpenTurnDiff}
      note={null}
    />
  );
});

type OutputsListFile = OutputFile & { readonly runId?: RunId | null };

/**
 * The Outputs section for any list of changed files, with the summed line
 * changes in its header. Rows with a run open that run's diff.
 */
export const ThreadOutputsList = memo(function ThreadOutputsList(props: {
  readonly outputs: ReadonlyArray<OutputsListFile>;
  readonly workspaceRoot: string | undefined;
  readonly onOpenTurnDiff: ((runId: RunId, filePath?: string) => void) | undefined;
  /** A caveat under the list, such as an older part of the session not being read. */
  readonly note: string | null;
}) {
  const { outputs } = props;
  const [showAll, setShowAll] = useState(false);
  const changes = useMemo(() => sumOutputChanges(outputs), [outputs]);
  if (outputs.length === 0) return null;

  const capped = outputs.length > OUTPUTS_INITIAL_COUNT;
  const visible = showAll ? outputs : outputs.slice(0, OUTPUTS_INITIAL_COUNT);
  return (
    <ThreadDetailsSection
      headingId="thread-details-outputs-heading"
      title={`Outputs · ${outputs.length}`}
      actions={
        changes === null ? undefined : (
          <span className="text-2xs" title="Changes">
            <DiffStatLabel
              additions={changes.additions}
              deletions={changes.deletions}
              layout="inline"
            />
          </span>
        )
      }
      data-thread-outputs-panel
    >
      <ul className="m-0 max-h-[17rem] list-none overflow-y-auto overscroll-contain p-0">
        {visible.map((output) => (
          <li key={output.path}>
            <OutputRow
              output={output}
              workspaceRoot={props.workspaceRoot}
              onOpenTurnDiff={props.onOpenTurnDiff}
            />
          </li>
        ))}
      </ul>
      {capped ? (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
          className={`flex h-8 w-full cursor-pointer items-center rounded-lg ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS} text-sm font-medium text-muted-foreground/70 hover:bg-black/[0.055] hover:text-foreground/80 dark:hover:bg-white/[0.075]`}
        >
          {showAll ? (
            <MinusIcon aria-hidden className="size-4 shrink-0" />
          ) : (
            <PlusIcon aria-hidden className="size-4 shrink-0" />
          )}
          {showAll ? "Show fewer" : `Show all ${outputs.length}`}
        </button>
      ) : null}
      {props.note === null ? null : (
        <p className="px-2.5 pt-1 text-2xs text-pretty text-muted-foreground">{props.note}</p>
      )}
    </ThreadDetailsSection>
  );
});

function OutputRow(props: {
  readonly output: OutputsListFile;
  readonly workspaceRoot: string | undefined;
  readonly onOpenTurnDiff: ((runId: RunId, filePath?: string) => void) | undefined;
}) {
  const { output, onOpenTurnDiff } = props;
  const content = (
    <>
      <FileDiffIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      <StartTruncatedPath
        path={formatWorkspaceRelativePath(output.path, props.workspaceRoot)}
        className="flex-1"
      />
      {output.hasStats ? (
        <span className="shrink-0 text-2xs">
          <DiffStatLabel
            additions={output.additions}
            deletions={output.deletions}
            layout="inline"
          />
        </span>
      ) : null}
    </>
  );
  const runId = output.runId ?? null;
  if (runId === null || onOpenTurnDiff === undefined) {
    return <div className={OUTPUT_ROW_CLASS}>{content}</div>;
  }
  return (
    <button
      type="button"
      className={cn(
        OUTPUT_ROW_CLASS,
        "cursor-pointer hover:bg-black/[0.055] dark:hover:bg-white/[0.075]",
      )}
      onClick={() => onOpenTurnDiff(runId, output.path)}
    >
      {content}
    </button>
  );
}
