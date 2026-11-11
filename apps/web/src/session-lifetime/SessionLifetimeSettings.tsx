/**
 * Session lifetime: one setting for how many days a paired app and a linked environment stay
 * signed in. Fork add-on: session lifetime.
 */
import {
  DEFAULT_SESSION_LIFETIME_DAYS,
  MAX_SESSION_LIFETIME_DAYS,
  MIN_SESSION_LIFETIME_DAYS,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Input } from "../components/ui/input";

const TITLE = "Session lifetime";

function SessionLifetimeDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [draftSource, setDraftSource] = useState(value);
  if (draftSource !== value) {
    setDraftSource(value);
    setDraft(String(value));
  }
  return (
    <Input
      size="sm"
      type="number"
      min={MIN_SESSION_LIFETIME_DAYS}
      max={MAX_SESSION_LIFETIME_DAYS}
      className="w-full sm:w-28"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_SESSION_LIFETIME_DAYS &&
          parsed <= MAX_SESSION_LIFETIME_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label={`${TITLE} in days`}
    />
  );
}

export function SessionLifetimeSettings() {
  const { scope } = useSettingsScope();
  const days = useScopedSettings((settings) => settings.sessionLifetimeDays);
  const updateSettings = useUpdateScopedSettings();
  // A session's lifetime belongs to the machine that issues it, not to a project.
  if (scope.kind !== "all" && scope.kind !== "environment") return null;
  return (
    <SettingsSection title={TITLE}>
      <SettingsRow
        serverScoped
        settingKeys={["sessionLifetimeDays"]}
        title="Days before pairing again"
        description="How long paired apps and linked machines stay signed in here. Sessions keep the lifetime they started with: pair or link again to change one. Revoke one in Sharing & access to end it sooner."
        resetAction={
          days !== DEFAULT_SESSION_LIFETIME_DAYS ? (
            <SettingResetButton
              label={TITLE.toLowerCase()}
              onClick={() => updateSettings({ sessionLifetimeDays: DEFAULT_SESSION_LIFETIME_DAYS })}
            />
          ) : null
        }
        control={
          <SessionLifetimeDaysInput
            value={days}
            onCommit={(next) => updateSettings({ sessionLifetimeDays: next })}
          />
        }
      />
    </SettingsSection>
  );
}
