// Fork-owned: release-source classification and download guards for host updates. Re-exported
// through `@t3tools/shared/cliRelease` because the shared package has no subpath for this file.

export type CliReleaseSource = "fork" | "upstream" | "custom";

export const CLI_RELEASE_REPOSITORY_ENV = "T3CODE_RELEASE_REPOSITORY";
const CLI_RELEASE_REPOSITORY = "travisjneuman/t3code";

export function cliReleaseRepositoryProblem(repository: string | undefined): string | undefined {
  const trimmed = repository?.trim();
  if (!trimmed) return undefined;
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/.exec(
    trimmed,
  );
  return match && match[2] !== "." && match[2] !== ".."
    ? undefined
    : "T3CODE_RELEASE_REPOSITORY must be a GitHub owner/name. Fix or remove it, then try again.";
}

export function cliReleaseRepositoryOf(
  repository: string | undefined,
  baseUrl: string | undefined = undefined,
): string {
  const problem = cliReleaseRepositoryProblem(repository);
  if (problem) throw new Error(problem);
  if (repository?.trim()) return repository.trim();
  const fromBase = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/*$/.exec(
    baseUrl?.trim() ?? "",
  )?.[1];
  return fromBase && fromBase === fromBase.trim() && cliReleaseRepositoryProblem(fromBase) === undefined
    ? fromBase
    : CLI_RELEASE_REPOSITORY;
}

const cliReleaseDefaultBaseUrl = (repository: string) =>
  `https://github.com/${repository}/releases/download`;

export function cliReleaseSourceOf(
  baseUrl: string | undefined,
  repository: string = CLI_RELEASE_REPOSITORY,
) {
  return classifyCliReleaseBaseUrl(baseUrl?.trim() || cliReleaseDefaultBaseUrl(repository));
}

export function cliReleaseDownloadBaseUrl(
  version: string,
  baseUrl: string | undefined = undefined,
  repository: string = CLI_RELEASE_REPOSITORY,
): string {
  return `${(baseUrl?.trim() || cliReleaseDefaultBaseUrl(repository)).replace(/\/+$/, "")}/v${version}`;
}

export function cliReleaseIndexPageUrl(
  page: number,
  repository: string = CLI_RELEASE_REPOSITORY,
): string {
  return `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`;
}

export function cliReleaseChannelOf(version: string) {
  // Fork host builds append `+<fork build>`, which keeps the channel.
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+(?:\+[0-9A-Za-z.-]+)?$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}

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
