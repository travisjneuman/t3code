import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { BotIcon, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export function threadRelationshipStatusLabel(status: string | null): string {
  switch (status) {
    case "preparing":
    case "starting":
      return "Starting";
    case "running":
    case "in_progress":
      return "Running";
    case "pending":
    case "queued":
      return "Queued";
    case "waiting":
    case "blocked":
      return "Waiting";
    case "completed":
      return "Done";
    case "failed":
    case "error":
      return "Failed";
    case "cancelled":
    case "interrupted":
      return "Stopped";
    case "rolled_back":
      return "Reverted";
    case "resolved_native":
      return "Resolved (native)";
    case "resolved_portable":
      return "Resolved (portable)";
    case "consumed":
      return "Consumed";
    case "superseded":
      return "Superseded";
    case "idle":
      return "Idle";
    default:
      return "Unknown";
  }
}

export function ThreadRelationshipIcon({
  driver,
  provider,
  providerEntries = [],
  status,
  fallbackIcon: FallbackIcon = BotIcon,
  compact = false, // Fork add-on(subagent-tree)
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
  providerEntries?: ReadonlyArray<ProviderInstanceEntry>;
  status: string | null;
  fallbackIcon?: LucideIcon;
  compact?: boolean; // Fork add-on(subagent-tree)
}) {
  const iconClassName = `${compact ? "size-3" : "size-4"} shrink-0 text-muted-foreground`; // Fork add-on(subagent-tree)
  const entry = driver
    ? providerEntries.find((candidate) => candidate.instanceId === provider?.instanceId)
    : undefined;
  const showInstanceBadge = entry !== undefined && shouldShowInstanceBadge(entry, providerEntries);
  return (
    <span
      className={
        `relative inline-flex ${compact ? "size-3" : "size-4"} shrink-0 items-center justify-center` /* Fork add-on(subagent-tree) */
      }
    >
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={entry?.displayName ?? provider?.displayName ?? driver}
          accentColor={entry?.accentColor}
          acpRegistryAgentId={entry?.acpRegistryAgentId}
          acpRegistryIconUrl={entry?.acpRegistryIconUrl ?? provider?.iconUrl}
          showBadge={showInstanceBadge}
          size="compact"
          iconClassName={iconClassName}
          className="z-auto"
        />
      ) : (
        <FallbackIcon className={iconClassName} />
      )}
      <span
        className={cn(
          compact // Fork add-on(subagent-tree)
            ? "absolute size-1.5 rounded-full border border-card" // Fork add-on(subagent-tree)
            : "absolute size-2 rounded-full border-2 border-card", // Fork add-on(subagent-tree)
          showInstanceBadge
            ? compact // Fork add-on(subagent-tree)
              ? "-left-0.5 -top-0.5" // Fork add-on(subagent-tree)
              : "-left-1 -top-1"
            : compact // Fork add-on(subagent-tree)
              ? "-bottom-0.5 -right-0.5" // Fork add-on(subagent-tree)
              : "-bottom-1 -right-1",
          status === "running" ||
            status === "in_progress" ||
            status === "pending" ||
            status === "waiting"
            ? "bg-info"
            : status === "failed" || status === "error"
              ? "bg-destructive"
              : status === "completed"
                ? "bg-success"
                : "bg-muted-foreground/45",
        )}
        aria-hidden="true"
      />
    </span>
  );
}
