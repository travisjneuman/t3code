/**
 * The composer's OpenBot agent picker, beside the model picker. Each agent has one conversation in
 * T3, so picking another agent opens its main conversation and takes the typed message along. A
 * new thread starts on the Chief of Staff. Fork add-on: OpenBot provider.
 */
import {
  type EnvironmentId,
  type OpenBotSessionsListResult,
  openBotAgentLabel,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import {
  ComposerControlIcon,
  ComposerSelectControl,
  type ComposerControlSize,
} from "../components/chat/ComposerControl";
import { useComposerMenuProps } from "../components/chat/composerEventScope";
import { useComposerMenuState } from "../components/chat/useComposerMenuState";
import { Select, SelectItem, SelectPopup } from "../components/ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { type ComposerThreadTarget, useComposerDraftStore } from "../composerDraftStore";
import { useQuietThreadShell } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  defaultOpenBotAgent,
  openbotSessionsList,
  openOpenBotAgentThread,
  runOpenBot,
} from "./openbotSessions";

export const OpenBotAgentControl = memo(function OpenBotAgentControl(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly draftTarget: ComposerThreadTarget | null;
  readonly size: ComposerControlSize;
  readonly hidden: boolean;
}) {
  const { environmentId, instanceId, threadId, draftTarget } = props;
  const navigate = useNavigate();
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const [listing, setListing] = useState<OpenBotSessionsListResult | null>(null);
  const [nonce, setNonce] = useState(0);
  const shell = useQuietThreadShell(scopeThreadRef(environmentId, threadId));

  useEffect(() => {
    let cancelled = false;
    void runOpenBot(openbotSessionsList, environmentId, { instanceId }, null).then((result) => {
      if (!cancelled && result !== null) setListing(result);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, instanceId, threadId, nonce]);

  const agents = (listing?.agents ?? []).toSorted((a, b) => a.name.localeCompare(b.name));
  const boundAgentId = listing?.conversations.find(
    (conversation) => conversation.threadId === threadId,
  )?.agentId;
  const agentId = boundAgentId ?? defaultOpenBotAgent(listing?.agents ?? [])?.id;
  const agent = agents.find((candidate) => candidate.id === agentId);
  const label = agent ? openBotAgentLabel(agent.name, agent.title) : (shell?.title ?? "Agent");

  const switchAgent = async (value: string | null) => {
    const picked = agents.find((candidate) => candidate.id === value);
    if (picked?.conversationId === undefined || picked.id === agentId) return;
    const threadRef = await openOpenBotAgentThread(
      environmentId,
      instanceId,
      picked.conversationId,
    );
    if (threadRef === null) return;
    const drafts = useComposerDraftStore.getState();
    const prompt = draftTarget === null ? "" : (drafts.getComposerDraft(draftTarget)?.prompt ?? "");
    if (draftTarget !== null && prompt.trim() && !drafts.getComposerDraft(threadRef)?.prompt) {
      drafts.setPrompt(threadRef, prompt);
      drafts.setPrompt(draftTarget, "");
    }
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };

  return (
    <Tooltip>
      <Select
        open={open}
        onOpenChange={(next) => {
          if (next) setNonce((count) => count + 1);
          setOpen(next);
        }}
        value={agentId ?? ""}
        onValueChange={(value) => void switchAgent(value)}
      >
        <TooltipTrigger
          render={<ComposerSelectControl size={props.size} aria-label="OpenBot agent" />}
        >
          <ComposerControlIcon icon={BotIcon} size={props.size} />
          <span data-composer-control-label>{label}</span>
        </TooltipTrigger>
        <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
          {agents.map((candidate) => (
            <SelectItem
              key={candidate.id}
              value={candidate.id}
              disabled={!candidate.sendable || candidate.conversationId === undefined}
              hideIndicator
            >
              {openBotAgentLabel(candidate.name, candidate.title)}
              {candidate.sendable ? null : " (Local scripts off)"}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <TooltipPopup side="top">
        The OpenBot agent you are messaging. Pick another to open its main conversation; agents
        still message each other in OpenBot.
      </TooltipPopup>
    </Tooltip>
  );
});
