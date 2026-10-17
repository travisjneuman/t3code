import { InlineButton } from "~/components/ui/button";
import {
  hostReleaseCheckFailureNotice,
  useHostReleaseCheck,
  useRefreshHostUpdateTarget,
} from "./hostRelease";

/** One muted line above the host rows when the fork release check failed; nothing otherwise. */
export function HostReleaseCheckNotice() {
  const notice = hostReleaseCheckFailureNotice(useHostReleaseCheck());
  const refresh = useRefreshHostUpdateTarget();
  if (notice === null) return null;
  return (
    <div className="flex min-w-0 items-center gap-1 px-3 py-2 text-muted-foreground text-xs sm:px-4">
      <span className="min-w-0 truncate">{notice}</span>
      <span aria-hidden className="shrink-0">
        ·
      </span>
      <InlineButton tone="muted" className="shrink-0" onClick={refresh}>
        Retry
      </InlineButton>
    </div>
  );
}
