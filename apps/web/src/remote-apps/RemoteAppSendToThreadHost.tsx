import {
  REMOTE_APP_DOWNLOAD_TEXT_MAX_BYTES,
  REMOTE_APP_SITE_INFO,
  remoteAppMarkdownFence,
  type DesktopRemoteAppBridge,
  type RemoteAppDownloadCapture,
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

// A download toast stays until it has been on screen this long, so one that
// arrives while a site covers T3 is still there when the user comes back.
const DOWNLOAD_TOAST_VISIBLE_MS = 30_000;

/** The selection as a Markdown quote under the site's name. */
export const formatRemoteAppQuote = ({ site, text }: RemoteAppSendToThread): string => {
  const quoted = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `From ${REMOTE_APP_SITE_INFO[site].label}:\n\n${quoted}`;
};

/** A downloaded text file as a fenced block under its site and filename. */
export const formatRemoteAppDownload = (
  capture: RemoteAppDownloadCapture,
  fileText: string,
): string => {
  const text = fileText.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const fence = remoteAppMarkdownFence(text);
  const filename = capture.filename.replaceAll("`", "'");
  return `From ${REMOTE_APP_SITE_INFO[capture.site].label}: \`${filename}\`\n\n${fence}${capture.language}\n${text}\n${fence}`;
};

const appendToDraft = (target: ComposerThreadTarget, block: string) => {
  const store = useComposerDraftStore.getState();
  const current = store.getComposerDraft(target)?.prompt.trimEnd() ?? "";
  store.setPrompt(target, current.length > 0 ? `${current}\n\n${block}` : block);
};

const downloadToastDescription = (capture: RemoteAppDownloadCapture): string => {
  const saved = `Saved to ${capture.path}`;
  if (capture.kind !== "text" || capture.text !== null) return saved;
  const limitKb = Math.round(REMOTE_APP_DOWNLOAD_TEXT_MAX_BYTES / 1_000);
  return `Larger than ${limitKb} KB, too large to add to a thread. ${saved}`;
};

/**
 * Receives what the user sent from a web app (selected text, or a downloaded
 * file they chose to add), appends it to the composer draft of the T3 thread
 * they were last on, and opens that thread. With no thread visited yet it
 * starts a draft in the first project. Downloads the user hasn't decided on
 * yet arrive as a toast offering the same. Renders nothing; it sits inside the
 * router so it can follow the thread routes.
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
    const deliver = async (block: string, what: string) => {
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
          description: `Open a project in T3, then send the ${what} again.`,
        });
        return;
      }
      appendToDraft(created.draftId, block);
    };

    const showInFolder = (capture: RemoteAppDownloadCapture) => {
      void bridge.showDownloadInFolder(capture.id).catch(() => undefined);
    };

    const offerDownload = (capture: RemoteAppDownloadCapture) => {
      const fileText = capture.text;
      if (fileText !== null && capture.addNow) {
        void deliver(formatRemoteAppDownload(capture, fileText), "file").catch(() => undefined);
        return;
      }
      const toastId = toastManager.add({
        type: "info",
        title: `Downloaded ${capture.filename}`,
        description: downloadToastDescription(capture),
        timeout: 0,
        actionProps:
          fileText === null
            ? {
                children: "Show in folder",
                onClick: () => {
                  toastManager.close(toastId);
                  showInFolder(capture);
                },
              }
            : {
                children: "Add to thread",
                onClick: () => {
                  toastManager.close(toastId);
                  void deliver(formatRemoteAppDownload(capture, fileText), "file").catch(
                    () => undefined,
                  );
                },
              },
        data: {
          dismissAfterVisibleMs: DOWNLOAD_TOAST_VISIBLE_MS,
          hideCopyButton: true,
          ...(fileText === null
            ? {}
            : {
                secondaryActionProps: {
                  children: "Show in folder",
                  onClick: () => showInFolder(capture),
                },
                secondaryActionVariant: "ghost" as const,
              }),
        },
      });
    };

    const stopSends = bridge.onSendToThread((send) => {
      void deliver(formatRemoteAppQuote(send), "selection").catch(() => undefined);
    });
    // An older desktop shell may not offer downloads yet.
    const stopDownloads =
      typeof bridge.onDownloadCaptured === "function"
        ? bridge.onDownloadCaptured(offerDownload)
        : () => undefined;
    return () => {
      stopSends();
      stopDownloads();
    };
  }, [bridge, navigate]);

  return null;
}
