// Fork add-on IPC channels, kept out of the upstream ipc/channels.ts. The
// preload imports this file, so it holds constants only.

// Native confirmation that stays above embedded WebContentsViews.
export const CONFIRM_DIALOG_CHANNEL = "desktop:confirm-dialog";

// Local source builds: merge upstream into the source checkout.
export const SOURCE_SYNC_CHANNEL = "desktop:update-sync-source";
export const SOURCE_SYNC_ENABLED_CHANNEL = "desktop:source-sync-enabled";

// Remote apps.
export const REMOTE_APP_GET_STATE_CHANNEL = "remote-app:get-state";
export const REMOTE_APP_SET_THEME_CHANNEL = "remote-app:set-theme";
export const REMOTE_APP_OPEN_SURFACE_MENU_CHANNEL = "remote-app:open-surface-menu";
export const REMOTE_APP_SET_AVAILABLE_SITES_CHANNEL = "remote-app:set-available-sites";
export const REMOTE_APP_SET_ACTIVE_SURFACE_CHANNEL = "remote-app:set-active-surface";
export const REMOTE_APP_GO_BACK_CHANNEL = "remote-app:go-back";
export const REMOTE_APP_GO_FORWARD_CHANNEL = "remote-app:go-forward";
export const REMOTE_APP_RELOAD_CHANNEL = "remote-app:reload";
export const REMOTE_APP_ZOOM_IN_CHANNEL = "remote-app:zoom-in";
export const REMOTE_APP_ZOOM_OUT_CHANNEL = "remote-app:zoom-out";
export const REMOTE_APP_RESET_ZOOM_CHANNEL = "remote-app:reset-zoom";
export const REMOTE_APP_RETRY_CHANNEL = "remote-app:retry";
export const REMOTE_APP_CLEAR_DATA_CHANNEL = "remote-app:clear-data";
export const REMOTE_APP_FILL_SITE_PROMPT_CHANNEL = "remote-app:fill-site-prompt";
export const REMOTE_APP_SHOW_DOWNLOAD_CHANNEL = "remote-app:show-download";
export const REMOTE_APP_IMPORT_CHAT_EXPORT_CHANNEL = "remote-app:import-chat-export";
// Main to renderer: the remote app state changed.
export const REMOTE_APP_STATE_CHANGE_CHANNEL = "remote-app:state-change";
// Main to renderer: text the user sent from a web app to the current T3 thread.
export const REMOTE_APP_SEND_TO_THREAD_CHANNEL = "remote-app:send-to-thread";
// Main to renderer: a text file or archive downloaded from a web app was saved.
export const REMOTE_APP_DOWNLOAD_CAPTURED_CHANNEL = "remote-app:download-captured";
