/**
 * A new session's lifetime, from the Session lifetime setting. Sessions are issued below the
 * settings service, so this reads the settings file, which holds only changed settings. A file
 * or value it cannot read keeps upstream's lifetime. Fork add-on: session lifetime.
 */
import * as NodeFS from "node:fs";

import {
  DEFAULT_SESSION_LIFETIME_DAYS,
  MAX_SESSION_LIFETIME_DAYS,
  MIN_SESSION_LIFETIME_DAYS,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";

export const sessionLifetime = (
  settingsPath: string,
  upstreamLifetime: Duration.Duration,
): Duration.Duration => {
  if (!NodeFS.existsSync(settingsPath)) return Duration.days(DEFAULT_SESSION_LIFETIME_DAYS);
  try {
    const settings: unknown = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"));
    if (typeof settings !== "object" || settings === null) return upstreamLifetime;
    if (!("sessionLifetimeDays" in settings)) return Duration.days(DEFAULT_SESSION_LIFETIME_DAYS);
    const days = settings.sessionLifetimeDays;
    return typeof days === "number" &&
      Number.isInteger(days) &&
      days >= MIN_SESSION_LIFETIME_DAYS &&
      days <= MAX_SESSION_LIFETIME_DAYS
      ? Duration.days(days)
      : upstreamLifetime;
  } catch {
    return upstreamLifetime;
  }
};
