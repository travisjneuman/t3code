/**
 * The compare page's message box: one prompt for both agents, in the regular
 * composer's surface. Below it, each side's model and options, as in a thread.
 * Build/Plan and access apply to both; attachments go to both (each side
 * uploads its own copy, since an upload belongs to one thread). Review swap
 * sits beside send, which turns into stop while either agent works.
 * Fork add-on: compare agents; see docs/user/compare-agents.md.
 */
import { useAtomValue } from "@effect/atom-react";
import { deriveThreadRuntime } from "@t3tools/client-runtime/state/thread-execution";
import { threadSupportsProviderHandoff } from "@t3tools/client-runtime/state/thread-workflows";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderInteractionMode,
  type ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ArrowLeftRightIcon, FileIcon, PaperclipIcon, XIcon } from "lucide-react";
import { type ClipboardEvent, type DragEvent, useMemo, useRef, useState } from "react";

import {
  getStartedThreadModelChangeBlockReason,
  resolveComposerInteractionMode,
} from "../components/ChatView.logic";
import { ComposerFooterModeControls } from "../components/chat/ChatComposer";
import {
  ComposerControl,
  ComposerControlIcon,
  ComposerControlSeparator,
} from "../components/chat/ComposerControl";
import { ComposerSurface } from "../components/chat/ComposerSurface";
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../components/chat/runtimeModeConfig";
import { TraitsPicker } from "../components/chat/TraitsPicker";
import { Spinner } from "../components/ui/spinner";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../composerDraftStore";
import { useEnvironmentSettings } from "../hooks/useSettings";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../lib/attachmentUploadQueue";
import { cn, randomUUID } from "../lib/utils";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { reviewSwap, sendFollowUp, stopComparison } from "./compareAgents";

/** An environment's settings, providers, and their instance entries as the pickers list them. */
export function useCompareProviders(environmentId: EnvironmentId) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  return { settings, providers, entries };
}

type Upload = ComposerImageAttachment | ComposerFileAttachment;

/** One attached file, uploaded once per side. */
interface CompareAttachment {
  readonly key: string;
  readonly name: string;
  readonly previewUrl: string | null;
  readonly sides: readonly [Upload, Upload];
}

const uploadFor = (file: File, previewUrl: string | null): Upload => {
  const base = {
    id: randomUUID(),
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    file,
  };
  return previewUrl === null ? { ...base, type: "file" } : { ...base, type: "image", previewUrl };
};

const attachmentRejection = (file: File): string | null => {
  if (file.size === 0) return `${file.name} is empty.`;
  const isImage = file.type.startsWith("image/");
  const limit = isImage ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  return file.size > limit
    ? `${file.name} is over ${limit / (1024 * 1024)} MB, the limit for ${isImage ? "images" : "files"}.`
    : null;
};

const errorToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const isWorking = (projection: OrchestrationV2ThreadProjection | null) =>
  projection?.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? false;

// ComposerPrimaryActions' round send and stop buttons, without the stage backdrop art.
const ROUND_ACTION_CLASS =
  "relative isolate flex size-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:size-8 [&_svg]:pointer-events-none";

type Pending = "swap" | "stop" | "follow-up" | null;

export function CompareComposer(props: {
  environmentId: EnvironmentId;
  pairId: string;
  left: OrchestrationV2ThreadProjection | null;
  right: OrchestrationV2ThreadProjection | null;
  /** Review swaps already sent, to label the next round. */
  swapsSent: number;
  /** Both sides have a finished latest answer. */
  finished: boolean;
}) {
  const { environmentId, pairId, left, right } = props;
  const { settings, providers, entries } = useCompareProviders(environmentId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ReadonlyArray<CompareAttachment>>([]);
  const [leftChoice, setLeftChoice] = useState<ModelSelection | null>(null);
  const [rightChoice, setRightChoice] = useState<ModelSelection | null>(null);
  const [interactionChoice, setInteractionChoice] = useState<ProviderInteractionMode | null>(null);
  const [runtimeChoice, setRuntimeChoice] = useState<RuntimeMode | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  const leftModel = leftChoice ?? left?.thread.modelSelection ?? null;
  const rightModel = rightChoice ?? right?.thread.modelSelection ?? null;
  const snapshotOf = (selection: ModelSelection | null) =>
    entries.find((entry) => entry.instanceId === selection?.instanceId)?.snapshot ?? null;
  const leftSnapshot = snapshotOf(leftModel);
  const rightSnapshot = snapshotOf(rightModel);

  // Plan mode only when both sides offer it; access modes both sides support.
  const leftPlan = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: leftSnapshot,
    interactionMode:
      interactionChoice ?? left?.thread.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
  });
  const rightPlan = resolveComposerInteractionMode({
    planModeEnabled: settings.planModeEnabled,
    provider: rightSnapshot,
    interactionMode: leftPlan.interactionMode,
  });
  const interactionMode = rightPlan.interactionMode;
  const runtimeModes = runtimeModeOptions
    .filter((mode) =>
      [leftSnapshot, rightSnapshot].every(
        (snapshot) =>
          !snapshot?.supportedRuntimeModes?.length || snapshot.supportedRuntimeModes.includes(mode),
      ),
    )
    .map((mode) => ({ mode, ...runtimeModeConfig[mode] }));
  const runtimeMode = runtimeChoice ?? left?.thread.runtimeMode ?? DEFAULT_RUNTIME_MODE;

  const working = isWorking(left) || isWorking(right);
  const canSend =
    !working &&
    pending === null &&
    text.trim() !== "" &&
    left !== null &&
    right !== null &&
    leftModel !== null &&
    rightModel !== null;
  const canSwap = !working && pending === null && props.finished;

  const run = async (kind: NonNullable<Pending>, action: () => Promise<boolean>) => {
    setPending(kind);
    try {
      return await action();
    } finally {
      setPending(null);
    }
  };

  const addFiles = (files: ReadonlyArray<File>) => {
    const room = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - attachments.length;
    const added: CompareAttachment[] = [];
    for (const file of files) {
      const rejection = attachmentRejection(file);
      if (rejection !== null) {
        errorToast("Could not attach a file", rejection);
        continue;
      }
      if (added.length >= room) {
        errorToast("Too many attachments", "Remove some before adding more.");
        break;
      }
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      const sides = [uploadFor(file, previewUrl), uploadFor(file, previewUrl)] as const;
      for (const image of sides) startAttachmentUpload({ environmentId, image });
      added.push({ key: randomUUID(), name: file.name, previewUrl, sides });
    }
    if (added.length > 0) setAttachments((current) => [...current, ...added]);
  };

  const discard = (removed: ReadonlyArray<CompareAttachment>, releaseUploads: boolean) => {
    if (releaseUploads) releaseDraftAttachments(removed.flatMap((attachment) => attachment.sides));
    for (const attachment of removed) {
      if (attachment.previewUrl !== null) URL.revokeObjectURL(attachment.previewUrl);
    }
    const keys = new Set(removed.map((attachment) => attachment.key));
    setAttachments((current) => current.filter((attachment) => !keys.has(attachment.key)));
  };

  const send = async () => {
    if (!canSend || leftModel === null || rightModel === null) return;
    const sent = attachments;
    await run("follow-up", async () => {
      await awaitAttachmentUploads(sent.flatMap((attachment) => attachment.sides.map((s) => s.id)));
      const leftAttachments = getUploadedAttachments({
        environmentId,
        images: sent.map((attachment) => attachment.sides[0]),
      });
      const rightAttachments = getUploadedAttachments({
        environmentId,
        images: sent.map((attachment) => attachment.sides[1]),
      });
      if (leftAttachments === null || rightAttachments === null) {
        errorToast(
          "Could not send the follow-up",
          "An attachment did not upload. Remove it or try again.",
        );
        return false;
      }
      const ok = await sendFollowUp(environmentId, {
        pairId,
        text: text.trim(),
        interactionMode,
        runtimeMode,
        left: { modelSelection: leftModel, attachments: leftAttachments },
        right: { modelSelection: rightModel, attachments: rightAttachments },
      });
      if (ok) {
        // The server claimed the uploads; releasing only clears the client's records.
        discard(sent, true);
        setText("");
        setLeftChoice(null);
        setRightChoice(null);
      }
      return ok;
    });
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    addFiles([...event.dataTransfer.files]);
  };

  return (
    <div className="chat-composer-lane w-full shrink-0 pt-1.5 sm:pt-2">
      <ComposerSurface.Shell contextStrip>
        <ComposerSurface.Host
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDrop={onDrop}
        >
          <div className="relative z-10">
            <ComposerSurface.Main>
              <div className="rounded-3xl">
                {attachments.length > 0 ? (
                  <div className="flex flex-wrap gap-2 px-3 pt-3 sm:px-4">
                    {attachments.map((attachment) => (
                      <AttachmentChip
                        key={attachment.key}
                        attachment={attachment}
                        onRemove={() => discard([attachment], true)}
                      />
                    ))}
                  </div>
                ) : null}
                <div className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4">
                  <textarea
                    aria-label="Follow-up for both agents"
                    className="block field-sizing-content max-h-50 min-h-12 w-full resize-none bg-transparent font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) leading-relaxed text-foreground outline-none placeholder:text-placeholder max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)"
                    placeholder={
                      working
                        ? "Both agents are working. You can send once they finish."
                        : "Ask both agents the same follow-up…"
                    }
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    onPaste={onPaste}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
                      event.preventDefault();
                      void send();
                    }}
                  />
                </div>
                <div className="flex min-w-0 flex-nowrap items-center justify-between gap-2 px-3 pb-3 sm:px-4 sm:pb-4">
                  <div className="-ms-1 flex min-w-0 items-center gap-1 overflow-hidden">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(event) => {
                        addFiles([...(event.target.files ?? [])]);
                        event.target.value = "";
                      }}
                    />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <ComposerControl
                            aria-label="Attach files for both agents"
                            onClick={() => fileInputRef.current?.click()}
                          />
                        }
                      >
                        <ComposerControlIcon icon={PaperclipIcon} />
                      </TooltipTrigger>
                      <TooltipPopup side="top">Attach files for both agents</TooltipPopup>
                    </Tooltip>
                    <ComposerFooterModeControls
                      showInteractionModeToggle={leftPlan.enabled && rightPlan.enabled}
                      interactionMode={interactionMode}
                      runtimeMode={runtimeMode}
                      runtimeModeOptions={runtimeModes}
                      onToggleInteractionMode={() =>
                        setInteractionChoice(interactionMode === "plan" ? "default" : "plan")
                      }
                      onRuntimeModeChange={setRuntimeChoice}
                    />
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <ComposerControl
                            disabled={!canSwap}
                            onClick={() =>
                              void run("swap", () => reviewSwap(environmentId, pairId))
                            }
                          />
                        }
                      >
                        {pending === "swap" ? (
                          <Spinner size="sm" aria-hidden="true" />
                        ) : (
                          <ComposerControlIcon icon={ArrowLeftRightIcon} />
                        )}
                        <span className="sr-only sm:not-sr-only">
                          {props.swapsSent === 0
                            ? "Review swap"
                            : `Review swap ${props.swapsSent + 1}`}
                        </span>
                      </TooltipTrigger>
                      <TooltipPopup side="top">
                        {working
                          ? "Waiting for both agents to finish."
                          : props.finished
                            ? "Send each agent the other's newest answer and ask it to compare and improve."
                            : "Needs a finished answer from both agents."}
                      </TooltipPopup>
                    </Tooltip>
                    {working ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              className={cn(
                                ROUND_ACTION_CLASS,
                                "bg-destructive/90 text-white shadow-destructive/24 hover:bg-destructive",
                              )}
                              disabled={pending !== null}
                              onClick={() =>
                                void run("stop", () => stopComparison(environmentId, pairId))
                              }
                              aria-label="Stop both agents"
                            />
                          }
                        >
                          {pending === "stop" ? (
                            <Spinner size="sm" aria-hidden="true" />
                          ) : (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="currentColor"
                              aria-hidden="true"
                            >
                              <rect x="2" y="2" width="8" height="8" rx="1.5" />
                            </svg>
                          )}
                        </TooltipTrigger>
                        <TooltipPopup>Stop both</TooltipPopup>
                      </Tooltip>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              className={cn(
                                ROUND_ACTION_CLASS,
                                "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover",
                              )}
                              disabled={!canSend}
                              onClick={() => void send()}
                              aria-label="Send to both"
                            />
                          }
                        >
                          {pending === "follow-up" ? (
                            <Spinner size="sm" aria-hidden="true" />
                          ) : (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 14 14"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </TooltipTrigger>
                        <TooltipPopup>Send to both (Ctrl/⌘ Enter)</TooltipPopup>
                      </Tooltip>
                    )}
                  </div>
                </div>
              </div>
            </ComposerSurface.Main>
          </div>
        </ComposerSurface.Host>
        <div className="min-h-0">
          <div className="relative z-0">
            <ComposerSurface.ContextStrip className="gap-1 ps-2 text-xs text-muted-foreground/70">
              <SideModel
                label="Left"
                projection={left}
                selection={leftModel}
                entries={entries}
                providers={providers}
                settings={settings}
                disabled={pending !== null}
                onChange={setLeftChoice}
              />
              <ComposerControlSeparator size="xs" />
              <SideModel
                label="Right"
                projection={right}
                selection={rightModel}
                entries={entries}
                providers={providers}
                settings={settings}
                disabled={pending !== null}
                onChange={setRightChoice}
              />
            </ComposerSurface.ContextStrip>
          </div>
        </div>
      </ComposerSurface.Shell>
      <div
        aria-hidden
        className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
      />
    </div>
  );
}

function AttachmentChip(props: { attachment: CompareAttachment; onRemove: () => void }) {
  const { attachment } = props;
  const [leftId, rightId] = [attachment.sides[0].id, attachment.sides[1].id];
  const status = useAttachmentUploadStore((store) => {
    const statuses = [
      store.uploadsByImageId[leftId]?.status,
      store.uploadsByImageId[rightId]?.status,
    ];
    if (statuses.includes("failed")) return "failed";
    return statuses.every((value) => value === "ready") ? "ready" : "uploading";
  });
  return (
    <div
      className={cn(
        "flex h-9 max-w-56 items-center gap-2 rounded-lg border bg-background/60 ps-1 pe-1.5 text-xs",
        status === "failed" && "border-destructive/50 text-destructive",
      )}
      title={status === "failed" ? `${attachment.name} did not upload` : attachment.name}
    >
      {attachment.previewUrl !== null ? (
        <img
          src={attachment.previewUrl}
          alt=""
          className="size-7 shrink-0 rounded-md object-cover"
        />
      ) : (
        <FileIcon className="ms-1 size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 truncate">{attachment.name}</span>
      {status === "uploading" ? <Spinner size="sm" aria-label="Uploading" /> : null}
      <button
        type="button"
        className="shrink-0 cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={`Remove ${attachment.name}`}
        onClick={props.onRemove}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

/** One side's model and options; a started thread keeps the switches its provider allows. */
function SideModel(props: {
  label: string;
  projection: OrchestrationV2ThreadProjection | null;
  selection: ModelSelection | null;
  entries: ReadonlyArray<ProviderInstanceEntry>;
  providers: ReturnType<typeof useCompareProviders>["providers"];
  settings: ReturnType<typeof useCompareProviders>["settings"];
  disabled: boolean;
  onChange: (selection: ModelSelection) => void;
}) {
  const { projection, selection, entries, providers, settings, onChange } = props;
  const modelOptions = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        providers,
        selection?.instanceId ?? null,
        selection?.model ?? null,
      ),
    [settings, providers, selection?.instanceId, selection?.model],
  );
  const handoff = useMemo(() => threadSupportsProviderHandoff(projection), [projection]);
  const runtime = useMemo(
    () => (projection === null ? null : deriveThreadRuntime(projection)),
    [projection],
  );
  const entry = entries.find((candidate) => candidate.instanceId === selection?.instanceId);
  if (projection === null || selection === null || entry === undefined) {
    return <span className="px-1">{props.label}: loading…</span>;
  }
  const blockReason = (instanceId: ProviderInstanceId, model: string) => {
    const reason = getStartedThreadModelChangeBlockReason({
      providers,
      hasStartedSession: runtime !== null,
      supportsProviderSwitchingViaHandoff: handoff,
      currentModelSelection: projection.thread.modelSelection,
      currentProviderInstanceId: runtime?.providerInstanceId ?? null,
      nextModelSelection: { instanceId, model },
    });
    return reason === null ? null : reason.description;
  };
  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      <span className="shrink-0 px-1 font-medium">{props.label}</span>
      <ProviderModelPicker
        compact={false}
        isComposerOwned
        size="xs"
        disabled={props.disabled}
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={handoff ? null : entry.driverKind}
        instanceEntries={entries}
        modelOptionsByInstance={modelOptions}
        getModelDisabledReason={blockReason}
        onInstanceModelChange={(instanceId, model) =>
          onChange(createModelSelection(instanceId, model))
        }
      />
      <TraitsPicker
        provider={entry.driverKind}
        instanceId={selection.instanceId}
        models={entry.models}
        model={selection.model}
        prompt=""
        onPromptChange={() => {}}
        modelOptions={selection.options ?? []}
        allowPromptInjectedEffort={false}
        planModeEnabled={settings.planModeEnabled}
        isComposerOwned
        size="xs"
        onModelOptionsChange={(options) =>
          onChange(createModelSelection(selection.instanceId, selection.model, options))
        }
      />
    </div>
  );
}
