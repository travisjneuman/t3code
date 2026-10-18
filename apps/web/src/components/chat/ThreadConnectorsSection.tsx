import type { SessionMcpServer } from "@t3tools/contracts";
import { PlugIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { mcpServerStatusPresentation } from "./sessionInsights.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadDetailsStatusDot } from "./ThreadDetailsStatRow";
import { THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS } from "./threadDetailsPanelStyles";

/** MCP servers the provider session has loaded, with their connection state. Fork add-on. */
export const ThreadConnectorsSection = memo(function ThreadConnectorsSection(props: {
  readonly servers: ReadonlyArray<SessionMcpServer>;
}) {
  return (
    <ThreadDetailsSection
      headingId="thread-details-connectors-heading"
      title="Connectors"
      data-thread-connectors-panel
    >
      {props.servers.length === 0 ? (
        <p className="px-2.5 py-1.5 text-2xs text-muted-foreground">No MCP servers loaded.</p>
      ) : (
        <ul className="m-0 max-h-[13.5rem] list-none overflow-y-auto overscroll-contain p-0">
          {props.servers.map((server) => (
            <ConnectorRow key={server.name} server={server} />
          ))}
        </ul>
      )}
    </ThreadDetailsSection>
  );
});

function ConnectorRow(props: { readonly server: SessionMcpServer }) {
  const { server } = props;
  const status = mcpServerStatusPresentation(server);
  const details = [
    server.version ? `v${server.version.replace(/^v/i, "")}` : null,
    server.toolCount !== undefined
      ? `${server.toolCount} ${server.toolCount === 1 ? "tool" : "tools"}`
      : null,
  ].filter((detail) => detail !== null);
  const statusLabel = (
    <span className="flex shrink-0 items-center gap-1.5 text-3xs text-muted-foreground">
      <ThreadDetailsStatusDot className={status.dotClassName} />
      {status.label}
    </span>
  );
  return (
    <li
      className={cn("flex items-center rounded-md py-0.5", THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS)}
    >
      <PlugIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-2xs/4 font-medium text-foreground/80">
          {server.name}
        </span>
        {details.length > 0 ? (
          <p className="truncate text-3xs/3.5 text-muted-foreground tabular-nums">
            {details.join(" · ")}
          </p>
        ) : null}
      </div>
      {status.hint ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" tabIndex={0} />}>
            {statusLabel}
          </TooltipTrigger>
          <TooltipPopup>{status.hint}</TooltipPopup>
        </Tooltip>
      ) : (
        statusLabel
      )}
    </li>
  );
}
