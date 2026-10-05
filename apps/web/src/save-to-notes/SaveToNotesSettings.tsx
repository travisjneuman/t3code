/**
 * Settings rows for Save to notes: the notes folder a summary is filed into,
 * and the folder full copies are written to. Both are paths on the server's
 * machine. Rendered in Settings, General, Projects & threads.
 * Fork add-on: save to notes.
 */
import type { ScopedSettingsPatch } from "../components/settings/scopedSettings";
import { SettingResetButton, SettingsRow } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { DraftInput } from "../components/ui/draft-input";

interface FolderRowProps {
  readonly settingKey: "notesDirectory" | "savedThreadsDirectory";
  readonly searchId: "save-to-notes-notes-folder" | "save-to-notes-saved-threads-folder";
  readonly label: string;
  readonly description: string;
  readonly patch: (value: string) => ScopedSettingsPatch;
}

const ROWS: ReadonlyArray<FolderRowProps> = [
  {
    settingKey: "notesDirectory",
    searchId: "save-to-notes-notes-folder",
    label: "Notes folder",
    description:
      "Where Save to notes, Summary asks the agent to file a note. The agent follows the folder's own AGENTS.md or CLAUDE.md to pick the spot.",
    patch: (value) => ({ notesDirectory: value }),
  },
  {
    settingKey: "savedThreadsDirectory",
    searchId: "save-to-notes-saved-threads-folder",
    label: "Saved threads folder",
    description:
      "Where Save to notes, Full copy writes a thread's prompts and final answers, one file per thread.",
    patch: (value) => ({ savedThreadsDirectory: value }),
  },
];

function FolderRow({ settingKey, searchId, label, description, patch }: FolderRowProps) {
  const value = useScopedSettings((settings) => settings[settingKey]);
  const mixed = useScopedSettingsMixed([settingKey]);
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={[settingKey]}
      {...searchableSetting(searchId)}
      description={description}
      resetAction={
        value !== "" ? (
          <SettingResetButton
            label={label.toLowerCase()}
            onClick={() => updateSettings(patch(""))}
          />
        ) : null
      }
      control={
        <DraftInput
          size="sm"
          className="w-full sm:w-72"
          value={mixed ? "" : value}
          onCommit={(next) => updateSettings(patch(next))}
          placeholder={mixed ? "Mixed" : "Not set"}
          spellCheck={false}
          aria-label={label}
        />
      }
    />
  );
}

export function SaveToNotesSettingsRows() {
  return ROWS.map((row) => <FolderRow key={row.settingKey} {...row} />);
}
