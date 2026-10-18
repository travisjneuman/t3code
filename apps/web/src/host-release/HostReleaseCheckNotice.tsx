import { hostReleaseCheckFailureNotice, useHostReleaseCheck } from "./hostRelease";

/** One muted line above the host rows when a local build is needed or unavailable. */
export function HostReleaseCheckNotice() {
  const notice = hostReleaseCheckFailureNotice(useHostReleaseCheck());
  if (notice === null) return null;
  return (
    <div className="flex min-w-0 items-center gap-1 px-3 py-2 text-muted-foreground text-xs sm:px-4">
      <span className="min-w-0 truncate">{notice}</span>
    </div>
  );
}
