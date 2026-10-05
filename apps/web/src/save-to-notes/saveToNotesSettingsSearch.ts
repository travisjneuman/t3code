/**
 * Settings search entries for the Save to notes folder rows, spread into
 * `SETTINGS_SEARCH_ITEMS`. Kept apart from the rows so the search catalog does
 * not import components. Fork add-on: save to notes.
 */
import type { SettingsSearchItem } from "../components/settings/settingsSearch";

export const SAVE_TO_NOTES_SETTINGS_SEARCH_ITEMS = [
  {
    id: "save-to-notes-notes-folder",
    title: "Notes folder",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["save to notes summary vault obsidian markdown folder path"],
  },
  {
    id: "save-to-notes-saved-threads-folder",
    title: "Saved threads folder",
    to: "/settings/general",
    scope: "environment-defaults",
    searchTerms: ["save to notes full copy transcript prompts answers folder path"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
