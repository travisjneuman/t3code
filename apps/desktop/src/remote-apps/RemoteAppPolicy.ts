import type { DesktopSurface } from "@t3tools/contracts";

export const REMOTE_APP_PARTITION = "persist:tjn-remote-chatgpt-v1";
export const REMOTE_APP_ENTRY_URL = "https://chatgpt.com/";

const TRUSTED_HOSTS = ["chatgpt.com", "openai.com", "auth.openai.com", "auth0.openai.com"] as const;
const AUTH_PROVIDER_HOSTS = new Set([
  "accounts.google.com",
  "oauth2.googleapis.com",
  "login.microsoftonline.com",
  "login.live.com",
  "appleid.apple.com",
]);
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

export const isTrustedRemoteHost = (host: string): boolean =>
  TRUSTED_HOSTS.some((trustedHost) => isHostBoundaryMatch(host.toLowerCase(), trustedHost));

export const isTrustedRemoteUrl = (rawUrl: string): boolean => {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      isTrustedRemoteHost(url.hostname)
    );
  } catch {
    return false;
  }
};

const isAuthOrCallbackUrl = (url: URL): boolean => {
  const haystack = `${url.hostname}${url.pathname}`.toLowerCase();
  return (
    AUTH_PROVIDER_HOSTS.has(url.hostname.toLowerCase()) ||
    haystack.includes("callback") ||
    haystack.includes("oauth") ||
    haystack.includes("authorize")
  );
};

export const sanitizePersistedUrl = (rawUrl: string): string | null => {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      url.username.length !== 0 ||
      url.password.length !== 0 ||
      !isTrustedRemoteHost(url.hostname) ||
      isAuthOrCallbackUrl(url)
    ) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
};

export const sanitizeRemoteTitle = (title: string): string => title.trim().slice(0, 512);

export const classifyRemoteAppNavigation = (
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
  if (isTrustedRemoteHost(url.hostname)) {
    return { kind: "embed", url: url.href };
  }
  if (AUTH_PROVIDER_HOSTS.has(url.hostname.toLowerCase())) {
    return options.authFlowActive
      ? { kind: "auth", url: url.href }
      : { kind: "deny", code: "untrusted-auth" };
  }
  return { kind: "external", url: url.href };
};

export const canUseRemoteAppControl = (surface: DesktopSurface): boolean => surface === "chatgpt";

export const isAllowedPermission = (permission: string, isTrustedMainFrame: boolean): boolean =>
  permission === "clipboard-sanitized-write" && isTrustedMainFrame;
