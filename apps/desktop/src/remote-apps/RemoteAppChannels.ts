// Fork add-on IPC channels for remote apps, kept out of the upstream
// ipc/channels.ts. The preload imports this file, so it holds constants only.
export const REMOTE_APP_FILL_SITE_PROMPT_CHANNEL = "remote-app:fill-site-prompt";
// Main to renderer: text the user sent from a web app to the current T3 thread.
export const REMOTE_APP_SEND_TO_THREAD_CHANNEL = "remote-app:send-to-thread";
// Main to renderer: a text file or archive downloaded from a web app was saved.
export const REMOTE_APP_DOWNLOAD_CAPTURED_CHANNEL = "remote-app:download-captured";
export const REMOTE_APP_SHOW_DOWNLOAD_CHANNEL = "remote-app:show-download";
export const REMOTE_APP_IMPORT_CHAT_EXPORT_CHANNEL = "remote-app:import-chat-export";
