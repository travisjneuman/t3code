import type { EnvironmentId, ExternalSessionMessage } from "@t3tools/contracts";
import { memo, useCallback, useLayoutEffect, useMemo, useRef } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { formatProviderDriverKindLabel } from "../providerModels";
import { useConnectedEnvironmentIds } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { externalSessionTitle, externalSessionTranscript, LIVENESS_LABEL } from "./atoms";

/** Within this many pixels of the bottom, new messages keep the view pinned there. */
const NEAR_BOTTOM_PX = 80;
const MESSAGE_HEADING_LEVEL = 3;

const LIVENESS_BADGE_VARIANT = {
  running: "success",
  idle: "warning",
  recent: "secondary",
} as const;

/**
 * Read-only live transcript of a session running outside T3. Key it by
 * environment and session so switching sessions starts from a fresh scroll
 * position.
 */
export function ExternalSessionView(props: { environmentId: EnvironmentId; sessionKey: string }) {
  const { environmentId, sessionKey } = props;
  const atom = useMemo(
    () => externalSessionTranscript({ environmentId, input: { key: sessionKey } }),
    [environmentId, sessionKey],
  );
  const { data, error, refresh } = useEnvironmentQuery(atom);
  const connected = useConnectedEnvironmentIds().includes(environmentId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    nearBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX;
  }, []);

  const messages = data?.messages;
  const messageCount = messages?.length ?? 0;
  const lastMessage = messages?.at(-1);
  // Follows the tail only when the reader is already there; scrolling up to
  // read history is never interrupted by new output.
  useLayoutEffect(() => {
    if (messageCount === 0 || !nearBottomRef.current) return;
    const element = scrollRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [messageCount, lastMessage]);

  const summary = data?.summary ?? null;
  const title = summary === null ? "External session" : externalSessionTitle(summary);
  const providerLabel = summary === null ? null : formatProviderDriverKindLabel(summary.driver);
  const meta =
    summary === null
      ? ""
      : [providerLabel, summary.model, summary.origin, summary.cwd]
          .filter((part): part is string => part !== null && part.length > 0)
          .join(" · ");
  const streamingMessageId =
    summary?.liveness === "running" && lastMessage?.role === "assistant" ? lastMessage.id : null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel="External session" className="overflow-hidden">
            <WorkspaceBreadcrumbItem>Other agents</WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="gap-2">
              {summary !== null && providerLabel !== null ? (
                <ProviderInstanceIcon
                  driverKind={summary.driver}
                  displayName={providerLabel}
                  iconClassName="size-4"
                />
              ) : null}
              <h1 className="truncate">{title}</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          <div className="flex shrink-0 items-center gap-1.5">
            {summary !== null ? (
              <Badge variant={LIVENESS_BADGE_VARIANT[summary.liveness]} size="sm">
                {LIVENESS_LABEL[summary.liveness]}
              </Badge>
            ) : null}
            <Badge variant="outline" size="sm">
              Read-only
            </Badge>
          </div>
        </WorkspacePageHeader>
        {meta.length > 0 ? (
          <div className="shrink-0 border-b border-border/60 pr-(--workspace-gutter-end) pb-2 pl-(--workspace-gutter-start)">
            <p className="truncate text-xs text-muted-foreground" title={meta}>
              {meta}
            </p>
          </div>
        ) : null}

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
        >
          <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-4 px-4 py-6">
            {data?.truncated ? (
              <p className="text-center text-xs text-muted-foreground/70">
                Earlier messages not shown
              </p>
            ) : null}
            {messages?.map((message) => (
              <ExternalSessionMessageRow
                key={message.id}
                message={message}
                cwd={summary?.cwd ?? undefined}
                environmentId={environmentId}
                isStreaming={message.id === streamingMessageId}
              />
            ))}
            {data !== null && messageCount === 0 ? (
              <p className="text-center text-xs text-muted-foreground/70">No messages yet</p>
            ) : null}
            <TranscriptStatus
              hasData={data !== null}
              error={error}
              connected={connected}
              onRetry={refresh}
            />
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

/** Quiet inline state for loading, stream failures, and lost connections. */
function TranscriptStatus(props: {
  hasData: boolean;
  error: string | null;
  connected: boolean;
  onRetry: () => void;
}) {
  if (props.error !== null) {
    return (
      <div
        role="status"
        className="flex flex-col items-center gap-2 text-center text-xs text-muted-foreground"
      >
        <span>Could not load this session.</span>
        <span className="text-muted-foreground/70">{props.error}</span>
        <Button variant="outline" size="xs" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (!props.connected) {
    return (
      <p role="status" className="text-center text-xs text-muted-foreground/70">
        {props.hasData ? "Disconnected. Reconnecting…" : "Waiting for the environment to connect…"}
      </p>
    );
  }
  if (!props.hasData) {
    return (
      <p role="status" className="text-center text-xs text-muted-foreground/70">
        Loading session…
      </p>
    );
  }
  return null;
}

/**
 * One transcript message. Memoized on the message object, which the
 * transcript reducer keeps stable until that message's content changes.
 */
const ExternalSessionMessageRow = memo(function ExternalSessionMessageRow(props: {
  message: ExternalSessionMessage;
  cwd: string | undefined;
  environmentId: EnvironmentId;
  isStreaming: boolean;
}) {
  const { message } = props;
  switch (message.role) {
    case "user":
      return (
        <div className="flex flex-col items-end gap-1">
          <div className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
            <h3 className="sr-only select-none">User</h3>
            <ChatMarkdown
              text={message.text}
              cwd={props.cwd}
              environmentId={props.environmentId}
              className="text-foreground"
              lineBreaks
              parseRawHtml={false}
              headingLevelOffset={MESSAGE_HEADING_LEVEL}
            />
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="relative min-w-0 px-1 py-0.5">
          <h3 className="sr-only select-none">Agent</h3>
          <ChatMarkdown
            text={message.text}
            cwd={props.cwd}
            environmentId={props.environmentId}
            isStreaming={props.isStreaming}
            headingLevelOffset={MESSAGE_HEADING_LEVEL}
          />
        </div>
      );
    case "tool":
      return <ToolMessageLine text={message.text} />;
  }
});

function ToolMessageLine(props: { text: string }) {
  const firstLine = props.text.trimStart().split("\n", 1)[0] ?? "";
  return (
    <p
      className="truncate px-1 font-mono text-xs text-muted-foreground/70"
      title={props.text.length > 1000 ? `${props.text.slice(0, 1000)}…` : props.text}
    >
      {firstLine}
    </p>
  );
}
