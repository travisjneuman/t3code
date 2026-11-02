/**
 * The composer's OpenBot agent picker, beside the model picker. A new chat's agent can change
 * until its first message; after that, and in any other OpenBot thread, it shows the agent alone.
 * Fork add-on: OpenBot provider.
 */
import {
  type EnvironmentId,
  isOpenBotNewChatThread,
  type OpenBotSessionsListResult,
  openBotAgentLabel,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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
import { useQuietThreadShell } from "../state/entities";
import { openbotSessionsList, openbotSessionsSetAgent, runOpenBot } from "./openbotSessions";

export const OpenBotAgentControl = memo(function OpenBotAgentControl(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly size: ComposerControlSize;
  readonly hidden: boolean;
}) {
  const { environmentId, instanceId, threadId } = props;
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const [listing, setListing] = useState<OpenBotSessionsListResult | null>(null);
  const [nonce, setNonce] = useState(0);
  const shell = useQuietThreadShell(scopeThreadRef(environmentId, threadId));
  const started = (shell?.latestRun ?? null) !== null;

  useEffect(() => {
    let cancelled = false;
    void runOpenBot(openbotSessionsList, environmentId, { instanceId }, null).then((result) => {
      if (!cancelled && result !== null) setListing(result);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, instanceId, threadId, started, nonce]);

  const pending = listing?.pendingChats?.find((chat) => chat.threadId === threadId);
  const agentId =
    pending?.agentId ??
    listing?.conversations.find((conversation) => conversation.threadId === threadId)?.agentId;
  const agents = (listing?.agents ?? []).toSorted((a, b) => a.name.localeCompare(b.name));
  const agent = agents.find((candidate) => candidate.id === agentId);
  const editable = isOpenBotNewChatThread(threadId) && pending !== undefined && !started;
  const label = agent ? openBotAgentLabel(agent.name, agent.title) : (shell?.title ?? "Agent");
  const tooltip = editable
    ? "The OpenBot agent for this chat. It is fixed once you send the first message."
    : "This chat stays with its agent. Start a new chat from the OpenBot section to talk to another; agents can still message each other in OpenBot.";

  const setAgent = async (value: string | null) => {
    if (!value || value === agentId) return;
    await runOpenBot(
      openbotSessionsSetAgent,
      environmentId,
      { instanceId, threadId, agentId: value },
      "Could not change the OpenBot agent",
    );
    setNonce((count) => count + 1);
  };

  return (
    <Tooltip>
      <Select
        open={open && editable}
        onOpenChange={(next) => {
          if (next) setNonce((count) => count + 1);
          setOpen(next);
        }}
        value={agentId ?? ""}
        onValueChange={(value) => void setAgent(value)}
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
              disabled={!candidate.sendable}
              hideIndicator
            >
              {openBotAgentLabel(candidate.name, candidate.title)}
              {candidate.sendable ? null : " (Local scripts off)"}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
});
