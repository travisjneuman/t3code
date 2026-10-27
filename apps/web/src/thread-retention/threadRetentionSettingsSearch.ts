/**
 * Settings search entries for Settings → Archive storage, retention and
 * settled threads, spread into `SETTINGS_SEARCH_ITEMS`. Fork add-on: thread retention.
 */
import type { SettingsSearchItem } from "../components/settings/settingsSearch";

export const THREAD_RETENTION_SETTINGS_SEARCH_ITEMS = [
  {
    id: "thread-storage",
    title: "Thread storage",
    to: "/settings/archived",
    searchTerms: ["disk space size bytes database attachments usage settled archived"],
  },
  {
    id: "thread-retention-archive-settled",
    title: "Archive settled threads",
    to: "/settings/archived",
    scope: "environment-defaults",
    searchTerms: ["retention cleanup days automatically settled archive"],
  },
  {
    id: "thread-retention-delete-archived",
    title: "Delete archived threads",
    to: "/settings/archived",
    scope: "environment-defaults",
    searchTerms: ["retention cleanup days automatically purge free disk space"],
  },
  {
    id: "settled-threads",
    title: "Settled threads",
    to: "/settings/archived",
    searchTerms: ["settled shelf unsettle archive delete"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
