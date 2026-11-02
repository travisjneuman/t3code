/**
 * The composer's OpenBot agent, beside the model picker. An OpenBot thread is one agent's
 * conversation, so the agent shows here but doesn't change. Fork add-on: OpenBot provider.
 */
import {
  type EnvironmentId,
  type OpenBotSessionsListResult,
  openBotAgentLabel,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BotIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import {
  ComposerControl,
  ComposerControlIcon,
  type ComposerControlSize,
} from "../components/chat/ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useQuietThreadShell } from "../state/entities";
import { openbotSessionsList, runOpenBot } from "./openbotSessions";

export const OpenBotAgentControl = memo(function OpenBotAgentControl(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly size: ComposerControlSize;
}) {
  const { environmentId, instanceId, threadId } = props;
  const [listing, setListing] = useState<OpenBotSessionsListResult | null>(null);
  const shell = useQuietThreadShell(scopeThreadRef(environmentId, threadId));

  useEffect(() => {
    let cancelled = false;
    void runOpenBot(openbotSessionsList, environmentId, { instanceId }, null).then((result) => {
      if (!cancelled && result !== null) setListing(result);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, instanceId, threadId]);

  const agentId = listing?.conversations.find(
    (conversation) => conversation.threadId === threadId,
  )?.agentId;
  const agent = listing?.agents?.find((candidate) => candidate.id === agentId);
  const label = agent ? openBotAgentLabel(agent.name, agent.title) : (shell?.title ?? "Agent");

  return (
    <Tooltip>
      <TooltipTrigger render={<ComposerControl size={props.size} aria-label="OpenBot agent" />}>
        <ComposerControlIcon icon={BotIcon} size={props.size} />
        <span data-composer-control-label>{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        This chat stays with its agent. Agents still message each other in OpenBot.
      </TooltipPopup>
    </Tooltip>
  );
});
