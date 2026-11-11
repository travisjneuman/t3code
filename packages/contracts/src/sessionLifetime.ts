/**
 * Session lifetime: how many days a paired app's session and a linked environment's session
 * last before they need pairing again. forkServerSettings.ts spreads the field groups below.
 * Fork add-on: session lifetime.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const MIN_SESSION_LIFETIME_DAYS = 1;
export const MAX_SESSION_LIFETIME_DAYS = 36_500;
/** Ten years: a session on a private fleet ends when it is revoked, not when it ages out. */
export const DEFAULT_SESSION_LIFETIME_DAYS = 3_650;

export const SessionLifetimeDays = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_SESSION_LIFETIME_DAYS, maximum: MAX_SESSION_LIFETIME_DAYS }),
);

export const SessionLifetimeSettingsFields = {
  sessionLifetimeDays: SessionLifetimeDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SESSION_LIFETIME_DAYS)),
  ),
};

export const SessionLifetimeSettingsPatchFields = {
  sessionLifetimeDays: Schema.optionalKey(SessionLifetimeDays),
};
