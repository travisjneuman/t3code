import { REMOTE_APP_SITES, type DesktopSurface, type RemoteAppSite } from "@t3tools/contracts";

export interface RemoteAppSiteDefinition {
  readonly entryUrl: string;
  /** Each site keeps its own persistent cookie jar, isolated from the host and the other sites. */
  readonly partition: string;
  /** Hosts (and their subdomains) that stay inside the embedded view. */
  readonly hosts: ReadonlyArray<string>;
  /** Sign-in hosts this site uses beyond the shared identity providers. */
  readonly authHosts: ReadonlyArray<string>;
}

export const REMOTE_APP_SITE_DEFINITIONS: Record<RemoteAppSite, RemoteAppSiteDefinition> = {
  chatgpt: {
    entryUrl: "https://chatgpt.com/",
    // The original single-site partition name keeps existing ChatGPT sign-ins.
    partition: "persist:tjn-remote-chatgpt-v1",
    hosts: ["chatgpt.com", "openai.com"],
    authHosts: [],
  },
  claude: {
    entryUrl: "https://claude.ai/",
    partition: "persist:tjn-remote-claude-v1",
    hosts: ["claude.ai", "claude.com", "anthropic.com"],
    authHosts: [],
  },
  grok: {
    entryUrl: "https://grok.com/",
    partition: "persist:tjn-remote-grok-v1",
    hosts: ["grok.com", "x.ai"],
    authHosts: ["x.com", "twitter.com", "api.x.com"],
  },
  gemini: {
    entryUrl: "https://gemini.google.com/app",
    partition: "persist:tjn-remote-gemini-v1",
    hosts: ["gemini.google.com"],
    // Google's sign-in hops through accounts.youtube.com to set its cookies.
    authHosts: ["accounts.youtube.com"],
  },
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

/** The site whose embedded hosts include this URL, if any. */
export const resolveRemoteAppSiteForUrl = (rawUrl: string): RemoteAppSite | undefined => {
  const url = parseHttpsUrl(rawUrl);
  if (url === null) return undefined;
  return REMOTE_APP_SITES.find((site) => isTrustedRemoteHost(site, url.hostname));
};

const isAuthOrCallbackUrl = (site: RemoteAppSite, url: URL): boolean => {
  const haystack = `${url.hostname}${url.pathname}`.toLowerCase();
  return (
    isAuthProviderHost(site, url.hostname) ||
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
  if (site === undefined || isAuthOrCallbackUrl(site, url)) return null;
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
