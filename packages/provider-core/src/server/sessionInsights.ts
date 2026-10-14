import type { SessionMcpServer } from "@t3tools/contracts";

/**
 * Normalizers adapters use when mapping a provider's own session report into
 * the session insights contract, whose names must be non-blank and trimmed
 * and whose token counts must be non-negative integers.
 */

/** The trimmed text, or undefined when the provider sent nothing usable. */
export const sessionInsightText = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

/** Token counts arrive as estimates; negative or non-finite values count as zero. */
export const sessionInsightTokens = (value: number | null | undefined): number =>
  value === null || value === undefined || !Number.isFinite(value)
    ? 0
    : Math.max(0, Math.round(value));

/**
 * Builds one server row, or undefined when the provider gave it no name.
 * Optional fields are left off rather than set to undefined.
 */
export const sessionMcpServer = (input: {
  readonly name: string;
  readonly status: SessionMcpServer["status"];
  readonly error?: string | null | undefined;
  readonly version?: string | null | undefined;
  readonly toolCount?: number | undefined;
}): SessionMcpServer | undefined => {
  const name = sessionInsightText(input.name);
  if (name === undefined) {
    return undefined;
  }
  const error = sessionInsightText(input.error);
  const version = sessionInsightText(input.version);
  return {
    name,
    status: input.status,
    ...(error === undefined ? {} : { error }),
    ...(version === undefined ? {} : { version }),
    ...(input.toolCount === undefined ? {} : { toolCount: sessionInsightTokens(input.toolCount) }),
  };
};
