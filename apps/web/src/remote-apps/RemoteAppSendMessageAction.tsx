import {
  REMOTE_APP_SITE_INFO,
  REMOTE_APP_TRANSFER_TEXT_MAX_LENGTH,
  type DesktopRemoteAppBridge,
  type RemoteAppSite,
} from "@t3tools/contracts";
import { SendIcon } from "lucide-react";

import { resolveAssistantMessageCopyState } from "~/components/chat/MessagesTimeline.logic";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { RemoteAppSiteIcon } from "./RemoteAppSiteIcon";
import { useAvailableRemoteAppSites } from "./useRemoteAppSites";

const LABEL = "Send to a web app";

const remoteAppBridge = (): DesktopRemoteAppBridge | undefined => {
  if (typeof window === "undefined") return undefined;
  const bridge = window.desktopBridge?.remoteApps;
  return typeof bridge?.fillSitePrompt === "function" ? bridge : undefined;
};

const copyAndTell = async (title: string, text: string) => {
  const copied = await navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
  toastManager.add({
    type: copied ? "info" : "error",
    title,
    description: copied ? "The text is on your clipboard." : "Copying the text failed too.",
  });
};

/**
 * Places the text in the site's prompt box without submitting it. The shell
 * reports a missed prompt box on the site's own page ("copied") when it can,
 * since this renderer's toasts sit beneath the site's view; the toasts below
 * cover the cases where the shell is still on, or returned to, T3.
 */
const sendToSite = async (bridge: DesktopRemoteAppBridge, site: RemoteAppSite, text: string) => {
  const label = REMOTE_APP_SITE_INFO[site].label;
  const result = await bridge.fillSitePrompt({ site, text }).catch(() => null);
  switch (result) {
    case "filled":
    case "copied":
      return;
    case "input-not-found":
      // The shell already put the text on the clipboard.
      toastManager.add({
        type: "info",
        title: `Couldn't fill ${label}'s prompt box`,
        description: "The text is on your clipboard.",
      });
      return;
    case "unavailable":
      await copyAndTell(`${label} isn't available`, text);
      return;
    case null:
      await copyAndTell(`Couldn't send to ${label}`, text);
  }
};

// Mounted only while the menu is open, so closed message rows hold no subscriptions
// and do no work.
function RemoteAppSendMenuItems({
  bridge,
  text,
}: {
  readonly bridge: DesktopRemoteAppBridge;
  readonly text: string;
}) {
  const { sites } = useAvailableRemoteAppSites();
  if (sites.length === 0) {
    return <MenuItem disabled>No web apps are open</MenuItem>;
  }
  // Rendered for copy only when the menu opens, not on every timeline render.
  const rendered = resolveAssistantMessageCopyState({
    text,
    showCopyButton: true,
    streaming: false,
  }).text;
  if (rendered === null || rendered.trim().length === 0) {
    return <MenuItem disabled>Nothing to send</MenuItem>;
  }
  const payload = rendered.slice(0, REMOTE_APP_TRANSFER_TEXT_MAX_LENGTH);
  return (
    <>
      {sites.map((site) => (
        <MenuItem key={site} onClick={() => void sendToSite(bridge, site, payload)}>
          <RemoteAppSiteIcon site={site} />
          Send to {REMOTE_APP_SITE_INFO[site].label}
        </MenuItem>
      ))}
    </>
  );
}

/**
 * Desktop-only action on a finished assistant message: puts its text in a web
 * app's prompt box for the user to review and submit there.
 */
export function RemoteAppSendMessageAction({
  message,
  visible,
}: {
  readonly message: { readonly text: string };
  readonly visible: boolean;
}) {
  const bridge = remoteAppBridge();
  if (bridge === undefined || !visible || message.text.trim().length === 0) return null;

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<Button type="button" variant="ghost-muted" size="xs" aria-label={LABEL} />}
            />
          }
        >
          <SendIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>
          <p>{LABEL}</p>
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start">
        <RemoteAppSendMenuItems bridge={bridge} text={message.text} />
      </MenuPopup>
    </Menu>
  );
}
