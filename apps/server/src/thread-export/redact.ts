/**
 * What a thread export leaves out of the persisted projection: answers given
 * to provider auth-refresh requests, and inline binary payloads (data URLs or
 * long base64 runs) inside tool-call inputs and outputs, which become a short
 * placeholder. Everything else is exported as stored. Fork add-on: thread
 * export.
 *
 * @module thread-export/redact
 */
import type {
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

/** Counts of what was removed, reported in the export itself. */
export interface ThreadExportOmissions {
  binaryValues: number;
  authRefreshAnswers: number;
}

const DATA_URL = /^data:[^,]{0,200};base64,/i;
// Base64 alphabet only, no spaces: prose and code never form a run this long.
const BASE64_RUN = /^[A-Za-z0-9+/_-]+={0,2}$/;
const MIN_BASE64_CHARS = 1024;
const MAX_DEPTH = 64;

const isBinaryString = (value: string): boolean =>
  DATA_URL.test(value) || (value.length >= MIN_BASE64_CHARS && BASE64_RUN.test(value));

const placeholder = (value: string): string => {
  const payload = value.slice(value.indexOf(",") + 1);
  return `[binary data omitted from export, about ${Math.floor((payload.length * 3) / 4)} bytes]`;
};

const scrubBinary = (value: unknown, omissions: ThreadExportOmissions, depth = 0): unknown => {
  if (typeof value === "string") {
    if (!isBinaryString(value)) return value;
    omissions.binaryValues += 1;
    return placeholder(value);
  }
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((entry) => scrubBinary(entry, omissions, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = scrubBinary(entry, omissions, depth + 1);
  }
  return result;
};

const redactItem = (
  item: OrchestrationV2TurnItem,
  omissions: ThreadExportOmissions,
): OrchestrationV2TurnItem => {
  if (item.type !== "dynamic_tool") return item;
  const { output, ...rest } = item;
  return {
    ...rest,
    input: scrubBinary(item.input, omissions),
    ...(output === undefined ? {} : { output: scrubBinary(output, omissions) }),
  };
};

const redactRuntimeRequest = (
  request: OrchestrationV2RuntimeRequest,
  omissions: ThreadExportOmissions,
): OrchestrationV2RuntimeRequest => {
  if (request.kind !== "auth_refresh" || request.answers === undefined) return request;
  omissions.authRefreshAnswers += 1;
  const { answers: _answers, ...rest } = request;
  return rest;
};

export const redactProjection = (
  projection: OrchestrationV2ThreadProjection,
): {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly omissions: ThreadExportOmissions;
} => {
  const omissions: ThreadExportOmissions = { binaryValues: 0, authRefreshAnswers: 0 };
  const turnItems = projection.turnItems.map((item) => redactItem(item, omissions));
  // Inherited rows reference items of other threads; local rows reuse the
  // redacted item so the same item is not counted twice.
  const redactedById = new Map(turnItems.map((item) => [item.id, item]));
  return {
    projection: {
      ...projection,
      turnItems,
      visibleTurnItems: projection.visibleTurnItems.map((row) => ({
        ...row,
        item:
          row.visibility === "local"
            ? (redactedById.get(row.item.id) ?? redactItem(row.item, omissions))
            : redactItem(row.item, omissions),
      })),
      runtimeRequests: projection.runtimeRequests.map((request) =>
        redactRuntimeRequest(request, omissions),
      ),
    },
    omissions,
  };
};
