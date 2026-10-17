// Fork-owned: release-source classification and download guards for host updates. Re-exported
// through `@t3tools/shared/cliRelease` because the shared package has no subpath for this file.

export type CliReleaseSource = "fork" | "upstream" | "custom";

const FORK_RELEASE_BASE_URL = "https://github.com/travisjneuman/t3code/releases/download";
const UPSTREAM_RELEASE_BASE_URL = "https://github.com/pingdotgg/t3code/releases/download";

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.trim().replace(/\/+$/, "").toLowerCase();

/**
 * `effectiveBaseUrl` is the override when one is set, otherwise the build's default base URL.
 */
export function classifyCliReleaseBaseUrl(effectiveBaseUrl: string): CliReleaseSource {
  const normalized = normalizeBaseUrl(effectiveBaseUrl);
  if (normalized === normalizeBaseUrl(FORK_RELEASE_BASE_URL)) return "fork";
  if (normalized === normalizeBaseUrl(UPSTREAM_RELEASE_BASE_URL)) return "upstream";
  return "custom";
}

/**
 * Archives are verified against SHA256SUMS fetched from the same base, so a plain-HTTP mirror
 * lets anyone on the path swap both. Returns a user-facing reason, or undefined when the base is
 * unset (the HTTPS default applies) or acceptable.
 */
export function cliReleaseBaseUrlProblem(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;
  let protocol: string;
  try {
    protocol = new URL(trimmed).protocol;
  } catch {
    return "T3CODE_RELEASE_BASE_URL is not a valid URL. Fix or remove it, then try again.";
  }
  return protocol === "https:"
    ? undefined
    : `T3CODE_RELEASE_BASE_URL must use https:// (it uses ${protocol}). Fix or remove it, then try again.`;
}

/**
 * Release archives are a few hundred MB at most and are buffered in memory before the checksum
 * check, so a hostile or broken mirror must not be able to stream unbounded data.
 */
export const CLI_RELEASE_ASSET_MAX_BYTES = 768 * 1024 * 1024;

/** Phrased to follow a download step, e.g. "downloading the t3 release archive (…)". */
export function cliReleaseAssetSizeProblem(bytes: number): string | undefined {
  return bytes > CLI_RELEASE_ASSET_MAX_BYTES
    ? `stopped: larger than the ${CLI_RELEASE_ASSET_MAX_BYTES / (1024 * 1024)} MB download limit`
    : undefined;
}
