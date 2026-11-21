import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, useMessages, Var } from "gt-react"; // Fork add-on(status-colors)
import type { MessageResolver } from "~/i18n/messages";
import { CalendarClockIcon, PencilIcon, PlayIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { ScheduledRelativeLabel } from "../settings/ScheduledTasksSettings";
import { scheduleLabel } from "../settings/scheduledTasksSettings.logic";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

import { readEnvironmentScope } from "../../state/session";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

// Fork add-on(status-colors): theme tokens and a spoken label, matching the settings page.
const STATUS_DOT_CLASS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "bg-muted-foreground/40",
  running: "bg-info", // Fork add-on(status-colors)
  succeeded: "bg-success", // Fork add-on(status-colors)
  failed: "bg-destructive",
};

const LAST_RUN_LABEL: Record<
  ScheduledTask["lastRunStatus"],
  string
> /* Fork add-on(status-colors) */ = {
  never: msg("Not run yet"), // Fork add-on(status-colors)
  running: msg("Running", { $context: "scheduled task run status" }), // Fork add-on(status-colors)
  succeeded: msg("Last run succeeded"), // Fork add-on(status-colors)
  failed: msg("Last run failed"), // Fork add-on(status-colors)
}; // Fork add-on(status-colors)

function taskScheduleLine(
  task: ScheduledTask,
  timestampFormat: TimestampFormat,
  timeZone: string | undefined,
  resolve: MessageResolver,
) {
  return (
    <>
      {scheduleLabel(task.schedule, timestampFormat, timeZone, task.nextRunAt, resolve)}
      {task.blockedByPolicy !== undefined ? (
        ` · ${task.blockedByPolicy}`
      ) : task.enabled && task.nextRunAt !== null ? (
        <>
          {" · "}
          <T>
            next <ScheduledRelativeLabel value={task.nextRunAt} />
          </T>
        </>
      ) : task.enabled ? (
        ""
      ) : (
        <>
          {" · "}
          <T context="automation state">paused</T>
        </>
      )}
    </>
  );
}

export function ThreadAutomationsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(props.environmentId),
  );
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} }),
    useMessages(),
  );
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "thread automation toggle",
  });
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "thread automation run now",
  });
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const navigate = useNavigate();
  const gt = useGT();
  const m = useMessages();
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const boundTasks = (tasksQuery.data?.tasks ?? []).filter(
    (task) => task.threadId === props.threadId,
  );

  if (tasksQuery.error === null && boundTasks.length === 0) return null;

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: thrownErrorMessage(error, m) ?? String(error),
      }),
    );
  };

  const toggleEnabled = async (task: ScheduledTask, enabled: boolean) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    const result = await setTaskEnabled({
      environmentId: props.environmentId,
      input: { id: task.id, enabled },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not update automation"), squashAtomCommandFailure(result));
    }
  };

  const runNow = async (task: ScheduledTask) => {
    if (
      busyTaskId !== null ||
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope)
    )
      return;
    setBusyTaskId(task.id);
    const result = await runTaskNow({
      environmentId: props.environmentId,
      input: { id: task.id },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not run automation"), squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-automations-heading"
      title={gt("Automations")}
      data-thread-automations-panel
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label={gt("Manage scheduled tasks")}
                onClick={() =>
                  void navigate({
                    to: "/settings/scheduled-tasks",
                    search: { environmentId: props.environmentId },
                  })
                }
              >
                <Settings2Icon className="size-3.5" />
              </ThreadDetailsControl>
            }
          />
          <TooltipPopup>
            <T>Manage scheduled tasks</T>
          </TooltipPopup>
        </Tooltip>
      }
    >
      <ul className="m-0 max-h-[13.5rem] list-none overflow-y-auto p-0">
        {boundTasks.map((task) => (
          <li
            key={task.id}
            className={cn(
              "group flex items-center rounded-lg py-1.5",
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
            )}
          >
            <Tooltip /* Fork add-on(status-colors): last-run status on hover. */>
              <TooltipTrigger
                render={
                  <span className="relative inline-flex size-4 shrink-0 items-center justify-center" /> // Fork add-on(status-colors)
                }
              >
                <CalendarClockIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                <span
                  className={cn(
                    "absolute -right-1 -top-1 size-1.5 rounded-full",
                    STATUS_DOT_CLASS[task.lastRunStatus],
                  )}
                  aria-hidden
                />
                <span className="sr-only" /* Fork add-on(status-colors) */>
                  {m(LAST_RUN_LABEL[task.lastRunStatus]) /* Fork add-on(status-colors) */}
                </span /* Fork add-on(status-colors) */>
              </TooltipTrigger /* Fork add-on(status-colors) */>
              <TooltipPopup side="left" /* Fork add-on(status-colors) */>
                {m(LAST_RUN_LABEL[task.lastRunStatus]) /* Fork add-on(status-colors) */}
              </TooltipPopup /* Fork add-on(status-colors) */>
            </Tooltip /* Fork add-on(status-colors) */>
            <Tooltip>
              <TooltipTrigger render={<div className="min-w-0 flex-1" />}>
                <span className="block truncate text-sm font-medium text-foreground/80">
                  {task.title}
                </span>
                <p className="truncate text-2xs text-muted-foreground">
                  {taskScheduleLine(task, timestampFormat, tasksQuery.data?.timeZone, m)}
                </p>
              </TooltipTrigger>
              <TooltipPopup side="left">
                <p className="font-medium">{task.title}</p>
                <p className="text-muted-foreground">
                  {taskScheduleLine(task, timestampFormat, tasksQuery.data?.timeZone, m)}
                </p>
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    aria-label={gt("Edit {title}", { title: task.title })}
                    onClick={() =>
                      void navigate({
                        to: "/settings/scheduled-tasks",
                        search: { environmentId: props.environmentId, taskId: task.id },
                      })
                    }
                  >
                    <PencilIcon className="size-3.5" />
                  </ThreadDetailsControl>
                }
              />
              <TooltipPopup>
                <T>Edit automation</T>
              </TooltipPopup>
            </Tooltip>
            {/* Webhook tasks need a request from their URL. */}
            {task.schedule.type === "webhook" ? null : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ThreadDetailsControl
                      size="icon-xs"
                      variant="ghost"
                      part="icon"
                      aria-label={gt("Run {title} now", { title: task.title })}
                      disabled={
                        !canOperate || busyTaskId !== null || task.lastRunStatus === "running"
                      }
                      onClick={() => void runNow(task)}
                    >
                      <PlayIcon className="size-3.5" />
                    </ThreadDetailsControl>
                  }
                />
                <TooltipPopup>
                  <T>Run now</T>
                </TooltipPopup>
              </Tooltip>
            )}
            <Switch
              checked={task.enabled}
              disabled={!canOperate || busyTaskId !== null}
              aria-label={
                task.enabled
                  ? gt("Pause {title}", { title: task.title })
                  : gt("Resume {title}", { title: task.title })
              }
              onCheckedChange={(enabled) => void toggleEnabled(task, enabled)}
            />
          </li>
        ))}
      </ul>
      {/* Kept last: the details card treats a section whose last child is empty as empty. */}
      {tasksQuery.error !== null ? (
        <p className="px-2.5 py-1.5 text-2xs text-destructive">
          <T>
            Could not load automations: <Var>{tasksQuery.error}</Var>
          </T>
        </p>
      ) : null}
    </ThreadDetailsSection>
  );
}
