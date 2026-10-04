import type { RemoteAppSite } from "@t3tools/contracts";

/**
 * Each site keeps its own sidebar width. A small probe in the page reports
 * where that sidebar ends so the host titlebar and footer column can follow it.
 * It reports through console.debug, which the manager reads from the view's
 * console-message event, so the page needs no preload or IPC access.
 */
export const REMOTE_APP_SIDEBAR_PROBE_PREFIX = "__t3code_site_sidebar_width__:";

const SIDEBAR_SELECTORS: Record<RemoteAppSite, string> = {
  chatgpt: "aside.app-shell-left-panel",
  claude: "aside.dframe-sidebar",
  // shadcn sidebar: the peer wrapper spans the gap the sidebar reserves.
  grok: "div.peer[data-state][data-collapsible]",
  gemini: "bard-sidenav",
};

/** Parses a probe message; anything else on the console yields undefined. */
export const parseRemoteAppSidebarProbeMessage = (message: string): number | null | undefined => {
  if (!message.startsWith(REMOTE_APP_SIDEBAR_PROBE_PREFIX)) return undefined;
  const raw = message.slice(REMOTE_APP_SIDEBAR_PROBE_PREFIX.length);
  if (raw === "null") return null;
  const width = Number(raw);
  return Number.isFinite(width) && width >= 0 && width <= 1_024 ? Math.round(width) : undefined;
};

export const buildRemoteAppSidebarProbeScript = (site: RemoteAppSite): string => `
(() => {
  const key = "__t3codeRemoteSidebarProbe";
  if (window[key] && typeof window[key].refresh === "function") {
    window[key].refresh();
    return;
  }
  const selector = ${JSON.stringify(SIDEBAR_SELECTORS[site])};
  const prefix = ${JSON.stringify(REMOTE_APP_SIDEBAR_PROBE_PREFIX)};
  let observed = null;
  let reported;
  let timer = 0;
  const measure = () => {
    const element = document.querySelector(selector);
    if (element !== observed) {
      if (observed !== null) resizeObserver.unobserve(observed);
      observed = element;
      if (element !== null) resizeObserver.observe(element);
    }
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || rect.left > 2) return 0;
    return Math.max(0, Math.round(rect.right));
  };
  const report = (force) => {
    timer = 0;
    const width = measure();
    if (!force && width === reported) return;
    reported = width;
    console.debug(prefix + String(width));
  };
  // Collapse animations resize the sidebar every frame; report once it settles.
  const schedule = () => {
    if (timer !== 0) window.clearTimeout(timer);
    timer = window.setTimeout(() => report(false), 150);
  };
  const resizeObserver = new ResizeObserver(schedule);
  resizeObserver.observe(document.documentElement);
  document.addEventListener("click", schedule, true);
  document.addEventListener("transitionend", schedule, true);
  // Single-page sites mount their sidebar after the first paint.
  for (const delay of [0, 500, 1500, 3000, 6000]) window.setTimeout(schedule, delay);
  window[key] = { refresh: () => report(true) };
  report(true);
})();
`;
