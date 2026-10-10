import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isRemoteAppSite,
  REMOTE_APP_SITE_INFO,
  type RemoteAppSite,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ArrowLeft, ArrowRight, Maximize2, MoreVertical } from "lucide-react";
import type { ReactNode } from "react";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { RightPanelSurface } from "~/rightPanelStore";

import { RemoteAppSiteIcon } from "../RemoteAppSiteIcon";
import { REMOTE_APP_TEXT_SIZE_CHOICES, remoteAppTextSizeLabel } from "../remoteAppState";
import { useAvailableRemoteAppSites } from "../useRemoteAppSites";
import {
  setRemoteAppSiteTextSize,
  setRemoteAppSurface,
  useRemoteAppSiteTextSize,
} from "../useRemoteAppState";
import {
  type RemoteAppChatMode,
  type RemoteAppThreadChoice,
  useRemoteAppPanelMemory,
} from "./remoteAppPanelMemory";
import {
  adoptRemoteAppPanelPage,
  forgetRemoteAppPanelThreadChat,
  readRemoteAppPanelBridge,
  remoteAppPanelGoBack,
  remoteAppPanelGoForward,
  remoteAppPanelReload,
  remoteAppPanelSlotId,
  useRemoteAppPanelNavigation,
} from "./remoteAppPanelRuntime";
import { setRemoteAppPinnedFromPanel } from "./remoteAppPanelTabs";

const SUBHEADER_CLASS =
  "flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent";

/** The right panel's content for an app tab, or null for any other tab. */
export function renderRemoteAppPanel(
  surface: RightPanelSurface | null,
  visible: boolean,
  threadRef: ScopedThreadRef,
): ReactNode {
  if (surface?.kind !== "remote-app") return null;
  if (!isRemoteAppSite(surface.site)) {
    return <PanelMessage>This app is not available.</PanelMessage>;
  }
  return (
    <RemoteAppPanelView
      key={surface.site}
      site={surface.site}
      visible={visible}
      threadKey={scopedThreadKey(threadRef)}
    />
  );
}

function PanelMessage({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="max-w-sm text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function RemoteAppPanelView(props: {
  readonly site: RemoteAppSite;
  readonly visible: boolean;
  readonly threadKey: string;
}) {
  const { site, visible, threadKey } = props;
  const label = REMOTE_APP_SITE_INFO[site].label;
  const desktop = readRemoteAppPanelBridge() !== undefined;
  const { sites, loaded } = useAvailableRemoteAppSites();
  const available = sites.includes(site);
  const controls = desktop && available;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={SUBHEADER_CLASS} data-surface-subheader>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1">
          <RemoteAppSiteIcon site={site} />
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{label}</span>
        </div>
        {controls ? <PanelControls site={site} label={label} threadKey={threadKey} /> : null}
      </div>
      {!desktop ? (
        <PanelMessage>Available in the desktop app.</PanelMessage>
      ) : !loaded ? null : !available ? (
        <PanelMessage>{label} is turned off in Settings.</PanelMessage>
      ) : (
        <div className="relative min-h-0 flex-1">
          <BrowserSurfaceSlot
            tabId={remoteAppPanelSlotId(site)}
            visible={visible}
            className="absolute inset-0 h-full w-full"
          />
        </div>
      )}
    </div>
  );
}

function HeaderButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function PanelControls(props: {
  readonly site: RemoteAppSite;
  readonly label: string;
  readonly threadKey: string;
}) {
  const { site, label, threadKey } = props;
  const navigation = useRemoteAppPanelNavigation((state) => state.bySite[site]);
  return (
    <>
      <div className="flex items-center gap-0.5" role="group" aria-label="Navigation">
        <HeaderButton
          label="Back"
          disabled={navigation?.canGoBack !== true}
          onClick={() => remoteAppPanelGoBack(site)}
        >
          <ArrowLeft />
        </HeaderButton>
        <HeaderButton
          label="Forward"
          disabled={navigation?.canGoForward !== true}
          onClick={() => remoteAppPanelGoForward(site)}
        >
          <ArrowRight />
        </HeaderButton>
        <HeaderButton label="Reload" onClick={() => remoteAppPanelReload(site)}>
          <RefreshIcon />
        </HeaderButton>
      </div>
      <HeaderButton label="Open full window" onClick={() => void setRemoteAppSurface(site)}>
        <Maximize2 />
      </HeaderButton>
      <PanelMenu site={site} label={label} threadKey={threadKey} />
    </>
  );
}

type ThreadChoiceValue = RemoteAppThreadChoice | "app";

function PanelMenu(props: {
  readonly site: RemoteAppSite;
  readonly label: string;
  readonly threadKey: string;
}) {
  const { site, label, threadKey } = props;
  const pinned = useRemoteAppPanelMemory((state) => state.pinned.includes(site));
  const chatMode = useRemoteAppPanelMemory((state) => state.chatMode[site] ?? "shared");
  const threadChoice = useRemoteAppPanelMemory(
    (state) => state.threadChoice[threadKey]?.[site] ?? null,
  );
  const hasThreadChat = useRemoteAppPanelMemory(
    (state) => state.threadLinks[threadKey]?.[site] !== undefined,
  );
  const textSize = useRemoteAppSiteTextSize(site);

  const changeChatMode = (mode: RemoteAppChatMode) => {
    // The chat on screen becomes this thread's own, rather than a new one.
    if (mode === "per-thread" && threadChoice === null) adoptRemoteAppPanelPage(site, threadKey);
    useRemoteAppPanelMemory.getState().setChatMode(site, mode);
  };
  const changeThreadChoice = (value: ThreadChoiceValue) => {
    if (value === "own") adoptRemoteAppPanelPage(site, threadKey);
    useRemoteAppPanelMemory
      .getState()
      .setThreadChoice(threadKey, site, value === "app" ? null : value);
  };

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" type="button" aria-label={`${label} menu`} />
              }
            />
          }
        >
          <MoreVertical />
        </TooltipTrigger>
        <TooltipPopup>More</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6}>
        <MenuCheckboxItem
          checked={pinned}
          onCheckedChange={(checked) => setRemoteAppPinnedFromPanel(site, checked, threadKey)}
        >
          Pin to all threads
        </MenuCheckboxItem>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>App chat</MenuGroupLabel>
          <MenuRadioGroup
            value={chatMode}
            onValueChange={(value) => changeChatMode(value as RemoteAppChatMode)}
          >
            <MenuRadioItem value="shared">Same chat in every thread</MenuRadioItem>
            <MenuRadioItem value="per-thread">A chat per thread</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuRadioGroup
            value={threadChoice ?? "app"}
            onValueChange={(value) => changeThreadChoice(value as ThreadChoiceValue)}
          >
            <MenuRadioItem value="app">This thread: follow the app setting</MenuRadioItem>
            <MenuRadioItem value="own">This thread: keep its own chat</MenuRadioItem>
            <MenuRadioItem value="shared">This thread: use the shared chat</MenuRadioItem>
          </MenuRadioGroup>
          <MenuItem
            disabled={!hasThreadChat}
            onClick={() => forgetRemoteAppPanelThreadChat(site, threadKey)}
          >
            {"Forget this thread's chat"}
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Text size</MenuGroupLabel>
          <MenuRadioGroup
            value={String(textSize)}
            onValueChange={(value) => {
              const choice = REMOTE_APP_TEXT_SIZE_CHOICES.find((size) => String(size) === value);
              if (choice !== undefined) {
                void setRemoteAppSiteTextSize(site, choice === 1 ? null : choice);
              }
            }}
          >
            {REMOTE_APP_TEXT_SIZE_CHOICES.map((size) => (
              <MenuRadioItem key={size} value={String(size)}>
                {remoteAppTextSizeLabel(size)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
