import {
  REMOTE_APP_SITE_INFO,
  type DesktopRemoteAppBridge,
  type RemoteAppSendToThread,
} from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { toastManager } from "~/components/ui/toast";
import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  resolveThreadRouteTarget,
  type ThreadRouteTarget,
} from "~/threadRoutes";

/** The selection as a Markdown quote under the site's name. */
export const formatRemoteAppQuote = ({ site, text }: RemoteAppSendToThread): string => {
  const quoted = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `From ${REMOTE_APP_SITE_INFO[site].label}:\n\n${quoted}`;
};

const appendToDraft = (target: ComposerThreadTarget, block: string) => {
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(target)?.prompt.trimEnd() ?? "";
  store.setPrompt(target, current.length > 0 ? `${current}\n\n${block}` : block);
};

/**
 * Receives text the user sent from a web app's context menu, appends it to
 * the composer draft of the T3 thread they were last on, and opens that
 * thread. With no thread visited yet it starts a draft in the first project.
 * The shell has already switched the surface back to T3. Renders nothing; it
 * sits inside the router so it can follow the thread routes.
 */
export function RemoteAppSendToThreadHost({ bridge }: { readonly bridge: DesktopRemoteAppBridge }) {
  const navigate = useNavigate();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  // The last thread route stays the target while Settings or another page is open.
  const lastTargetRef = useRef<ThreadRouteTarget | null>(null);
  if (routeTarget !== null) lastTargetRef.current = routeTarget;
  const { handleNewThread, defaultProjectRef } = useHandleNewThread();
  const newThreadRef = useRef({ handleNewThread, defaultProjectRef });
  newThreadRef.current = { handleNewThread, defaultProjectRef };

  useEffect(() => {
    const deliver = async (send: RemoteAppSendToThread) => {
      const block = formatRemoteAppQuote(send);
      const target = lastTargetRef.current;
      if (target?.kind === "server") {
        appendToDraft(target.threadRef, block);
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(target.threadRef),
        });
        return;
      }
      if (target?.kind === "draft") {
        appendToDraft(target.draftId, block);
        await navigate({
          to: "/draft/$draftId",
          params: buildDraftThreadRouteParams(target.draftId),
        });
        return;
      }
      const { handleNewThread: startThread, defaultProjectRef: projectRef } = newThreadRef.current;
      const created = projectRef === null ? null : await startThread(projectRef);
      if (created === null) {
        toastManager.add({
          type: "warning",
          title: "No thread to send to",
          description: "Open a project in T3, then send the selection again.",
        });
        return;
      }
      appendToDraft(created.draftId, block);
    };
    return bridge.onSendToThread((send) => {
      void deliver(send).catch(() => undefined);
    });
  }, [bridge, navigate]);

  return null;
}
