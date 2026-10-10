import {
  REMOTE_APP_PARTITIONS,
  REMOTE_APP_SITES,
  type DesktopSurface,
  type RemoteAppSite,
} from "@t3tools/contracts";

export interface RemoteAppSiteDefinition {
  readonly entryUrl: string;
  /**
   * Each site keeps its own persistent cookie jar, isolated from the host and
   * the other sites. Shared with the side panel through REMOTE_APP_PARTITIONS.
   */
  readonly partition: string;
  /** Hosts (and their subdomains) that stay inside the embedded view. */
  readonly hosts: ReadonlyArray<string>;
  /** Sign-in hosts this site uses beyond the shared identity providers. */
  readonly authHosts: ReadonlyArray<string>;
  /**
   * CSS px of the site's chat reply text at 100% zoom. The shell zooms the site
   * so this lands on T3's chat text size (see resolveRemoteAppPageZoom).
   */
  readonly readingTextPx: number;
  /**
   * Hooks into the site's own markup. A site without them never shows the
   * finished-reply badge, and "Send to <site>" copies to the clipboard instead.
   */
  readonly page?: RemoteAppPageHooks;
}

/**
 * BEST-EFFORT, UNVERIFIED SELECTORS. They describe each site's markup as last
 * known, change without notice when a site ships a redesign, and need checking
 * against the live page (CDP) whenever badges or prompt fills stop working. A
 * stale selector fails quietly: `generating` falls back to the generic
 * activity heuristic in RemoteAppPageScripts.ts, and `promptInput` falls back
 * to copying the text.
 */
export interface RemoteAppPageHooks {
  /** Matches only while a reply is streaming, usually the Stop button. */
  readonly generating: ReadonlyArray<string>;
  /** The prompt box, most specific first; the first visible match wins. */
  readonly promptInput: ReadonlyArray<string>;
}

export const REMOTE_APP_SITE_DEFINITIONS: Record<RemoteAppSite, RemoteAppSiteDefinition> = {
  chatgpt: {
    entryUrl: "https://chatgpt.com/",
    partition: REMOTE_APP_PARTITIONS.chatgpt,
    hosts: ["chatgpt.com", "openai.com"],
    authHosts: [],
    // Measured 2026-10-10 on a shared chat: assistant markdown paragraphs are 16px.
    readingTextPx: 16,
    page: {
      generating: ['button[data-testid="stop-button"]'],
      // Checked 2026-10-04: a ProseMirror div labelled "Ask ChatGPT"; #prompt-textarea is gone.
      promptInput: [
        'div.ProseMirror[contenteditable="true"]',
        "#prompt-textarea",
        'div[contenteditable="true"]',
      ],
    },
  },
  claude: {
    entryUrl: "https://claude.ai/",
    partition: REMOTE_APP_PARTITIONS.claude,
    hosts: ["claude.ai", "claude.com", "anthropic.com"],
    authHosts: [],
    // Measured 2026-10-10 on a shared chat: reply paragraphs (.font-claude-response) are 16px.
    readingTextPx: 16,
    page: {
      generating: ['button[aria-label="Stop response"]', 'button[aria-label="Stop"]'],
      promptInput: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]'],
    },
  },
  grok: {
    entryUrl: "https://grok.com/",
    partition: REMOTE_APP_PARTITIONS.grok,
    hosts: ["grok.com", "x.ai"],
    // Sign-in hops the whole tab through each xAI property's auth.*/set-cookie to seed first-party cookies.
    authHosts: [
      "x.com",
      "twitter.com",
      "api.x.com",
      "auth.grokipedia.com",
      "auth.grokusercontent.com",
      "auth.cursor.com",
    ],
    // Measured 2026-10-10 on a shared chat: response markdown paragraphs are 15px.
    readingTextPx: 15,
    page: {
      generating: ['button[aria-label="Stop model response"]', 'button[aria-label="Stop"]'],
      // Checked 2026-10-04: a tiptap ProseMirror div; a hidden sizing textarea sits beside it.
      promptInput: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]'],
    },
  },
  gemini: {
    entryUrl: "https://gemini.google.com/app",
    partition: REMOTE_APP_PARTITIONS.gemini,
    hosts: ["gemini.google.com"],
    // Google's sign-in hops through accounts.youtube.com to set its cookies.
    authHosts: ["accounts.youtube.com"],
    // Measured 2026-10-10 on a shared chat: model-response paragraphs are 17px.
    readingTextPx: 17,
    page: {
      generating: ['button[aria-label="Stop response"]', "button.stop"],
      promptInput: ["rich-textarea .ql-editor", 'div[contenteditable="true"]'],
    },
  },
  // Standalone: no T3 provider. Google and Apple sign-in use the shared hosts.
  perplexity: {
    entryUrl: "https://www.perplexity.ai/",
    partition: REMOTE_APP_PARTITIONS.perplexity,
    hosts: ["perplexity.ai"],
    authHosts: [],
    // Measured 2026-10-10 on a shared thread: answer prose paragraphs are 16px.
    readingTextPx: 16,
    page: {
      generating: [
        'button[data-testid="stop-generating-response-button"]',
        'button[aria-label="Stop"]',
      ],
      promptInput: ["#ask-input", "textarea", 'div[contenteditable="true"]'],
    },
  },
};

/** T3's chat text (`text-sm`) as a fraction of its Interface font size. */
const T3_CHAT_TEXT_RATIO = 0.875;
const T3_DEFAULT_INTERFACE_FONT_SIZE = 16;

/**
 * The page zoom that puts a site's reply text at T3's chat text size, times
 * the user's per-site text size. `mainZoom` is T3's own window zoom, so the
 * two stay matched through Zoom In and Zoom Out.
 */
export const resolveRemoteAppPageZoom = (input: {
  readonly site: RemoteAppSite;
  readonly mainZoom: number;
  readonly interfaceFontSize: number | undefined;
  readonly textSize: number | undefined;
}): number => {
  const mainZoom = Number.isFinite(input.mainZoom) && input.mainZoom > 0 ? input.mainZoom : 1;
  const chatTextPx =
    (input.interfaceFontSize ?? T3_DEFAULT_INTERFACE_FONT_SIZE) * T3_CHAT_TEXT_RATIO;
  const ratio = chatTextPx / REMOTE_APP_SITE_DEFINITIONS[input.site].readingTextPx;
  return mainZoom * ratio * (input.textSize ?? 1);
};

const SHARED_AUTH_PROVIDER_HOSTS = [
  "accounts.google.com",
  "oauth2.googleapis.com",
  "login.microsoftonline.com",
  "login.live.com",
  "appleid.apple.com",
] as const;
const BLOCKED_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "ftp:",
  "blob:",
  "chrome:",
  "devtools:",
  "custom:",
]);

export type RemoteAppNavigationDecision =
  | { readonly kind: "embed"; readonly url: string }
  | { readonly kind: "auth"; readonly url: string }
  | { readonly kind: "external"; readonly url: string }
  | { readonly kind: "deny"; readonly code: "invalid-url" | "unsafe-scheme" | "untrusted-auth" };

const isHostBoundaryMatch = (host: string, trustedHost: string): boolean =>
  host === trustedHost || host.endsWith(`.${trustedHost}`);

const matchesAnyHost = (host: string, hosts: ReadonlyArray<string>): boolean => {
  const normalized = host.toLowerCase();
  return hosts.some((trustedHost) => isHostBoundaryMatch(normalized, trustedHost));
};

export const isTrustedRemoteHost = (site: RemoteAppSite, host: string): boolean =>
  matchesAnyHost(host, REMOTE_APP_SITE_DEFINITIONS[site].hosts);

const isAuthProviderHost = (site: RemoteAppSite, host: string): boolean =>
  matchesAnyHost(host, SHARED_AUTH_PROVIDER_HOSTS) ||
  matchesAnyHost(host, REMOTE_APP_SITE_DEFINITIONS[site].authHosts);

const parseHttpsUrl = (rawUrl: string): URL | null => {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0
      ? url
      : null;
  } catch {
    return null;
  }
};

export const isTrustedRemoteUrl = (site: RemoteAppSite, rawUrl: string): boolean => {
  const url = parseHttpsUrl(rawUrl);
  return url !== null && isTrustedRemoteHost(site, url.hostname);
};

/**
 * A download the site's own page started. Sites often build files in the page,
 * so a blob: URL counts when its origin is the site, and a data: URL when the
 * page that started it is on the site.
 */
export const isTrustedRemoteDownload = (
  site: RemoteAppSite,
  rawUrl: string,
  initiatorUrl: string,
): boolean => {
  if (isTrustedRemoteUrl(site, rawUrl)) return true;
  if (rawUrl.startsWith("blob:")) return isTrustedRemoteUrl(site, rawUrl.slice("blob:".length));
  return rawUrl.startsWith("data:") && isTrustedRemoteUrl(site, initiatorUrl);
};

/** The site whose embedded hosts include this URL, if any. */
export const resolveRemoteAppSiteForUrl = (rawUrl: string): RemoteAppSite | undefined => {
  const url = parseHttpsUrl(rawUrl);
  if (url === null) return undefined;
  return REMOTE_APP_SITES.find((site) => isTrustedRemoteHost(site, url.hostname));
};

// First-party sign-in steps (auth.openai.com, accounts.x.ai, /auth/logout,
// /login, /mfa-challenge/...) are one-shot pages that must never be replayed.
const FIRST_PARTY_AUTH_HOST = /^(auth|accounts|login)\./;
const FIRST_PARTY_AUTH_PATH =
  /\/(auth|log-?in|log-?out|sign-?in|sign-?up|sign-?out|mfa[\w-]*)(\/|$)/;

const isAuthOrCallbackUrl = (site: RemoteAppSite, url: URL): boolean => {
  const haystack = `${url.hostname}${url.pathname}`.toLowerCase();
  return (
    isAuthProviderHost(site, url.hostname) ||
    FIRST_PARTY_AUTH_HOST.test(url.hostname.toLowerCase()) ||
    FIRST_PARTY_AUTH_PATH.test(url.pathname.toLowerCase()) ||
    haystack.includes("callback") ||
    haystack.includes("oauth") ||
    haystack.includes("authorize")
  );
};

/**
 * Persisted URLs drop query and hash, and never keep a sign-in or callback
 * step, so a restart cannot replay credentials or one-time codes.
 */
export const sanitizePersistedUrl = (rawUrl: string): string | null => {
  const url = parseHttpsUrl(rawUrl);
  if (url === null) return null;
  const site = resolveRemoteAppSiteForUrl(url.href);
  if (site === undefined || url.port !== "" || isAuthOrCallbackUrl(site, url)) return null;
  url.search = "";
  url.hash = "";
  return url.href;
};

export const sanitizeRemoteTitle = (title: string): string => title.trim().slice(0, 512);

/**
 * Top-level sign-in redirects stay in the view so the site can finish its own
 * login; popups only reach identity providers while an auth flow is active.
 */
export const classifyRemoteAppNavigation = (
  site: RemoteAppSite,
  rawUrl: string,
  options: { readonly authFlowActive?: boolean } = {},
): RemoteAppNavigationDecision => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: "deny", code: "invalid-url" };
  }

  if (BLOCKED_SCHEMES.has(url.protocol) || url.protocol !== "https:") {
    return { kind: "deny", code: "unsafe-scheme" };
  }
  if (url.username.length !== 0 || url.password.length !== 0) {
    return { kind: "deny", code: "invalid-url" };
  }
  if (isTrustedRemoteHost(site, url.hostname)) {
    return { kind: "embed", url: url.href };
  }
  if (isAuthProviderHost(site, url.hostname)) {
    return options.authFlowActive
      ? { kind: "auth", url: url.href }
      : { kind: "deny", code: "untrusted-auth" };
  }
  return { kind: "external", url: url.href };
};

export const canUseRemoteAppControl = (surface: DesktopSurface): surface is RemoteAppSite =>
  surface !== "t3code";

export const isAllowedPermission = (permission: string, isTrustedMainFrame: boolean): boolean =>
  permission === "clipboard-sanitized-write" && isTrustedMainFrame;
