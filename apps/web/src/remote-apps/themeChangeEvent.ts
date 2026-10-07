/**
 * Window event fired after every theme store change, including edits that keep
 * the same theme name, so `RemoteAppThemeSync` can re-send colors to the web
 * apps. `useTheme`'s `emitChange` calls `dispatchThemeChange`. Fork add-on: remote apps.
 */
export const THEME_CHANGE_EVENT = "t3code:theme-change";

export function dispatchThemeChange(): void {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }
}
