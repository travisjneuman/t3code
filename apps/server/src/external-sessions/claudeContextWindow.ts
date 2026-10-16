/**
 * The context window an external Claude Code session measures usage against,
 * resolved the way the CLI resolves it: the `autoCompactWindow` setting (or
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW`) capped at the model's window, else the
 * model's window from T3's Claude catalog. The auto-compact threshold and
 * buffer follow the CLI's own arithmetic (Claude Code 2.1.30x): the threshold
 * sits `min(max output, 20k) + 13k` below the window, or lower at
 * `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` percent of the window less the output
 * reserve. Only the two auto-compact keys and that one `env` entry are kept
 * from each settings file. Fork add-on: session details.
 *
 * @module external-sessions/claudeContextWindow
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogContextWindowTokens,
} from "../provider/ClaudeModelCatalog.ts";
import { asRecord, parseJsonObject, readText, statMtimeMs } from "./ExternalSessionSource.ts";

/** What the CLI reserves for the summary's output, capped at 20k. */
const SUMMARY_OUTPUT_TOKENS = 20_000;
/** What the CLI reserves below the window: summary output plus 13k. */
const AUTO_COMPACT_BUFFER_TOKENS = SUMMARY_OUTPUT_TOKENS + 13_000;
const RESTAT_MS = 5 * 1000;
const MAX_CACHED_FILES = 200;
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");

export interface ClaudeContextWindow {
  /** Tokens usage is measured against. */
  readonly window: number;
  readonly autoCompactEnabled: boolean;
  /** Tokens in context at which the CLI compacts; null while auto-compact is off. */
  readonly autoCompactThreshold: number | null;
}

interface AutoCompactSettings {
  readonly window: number | null;
  readonly enabled: boolean | null;
  readonly percent: number | null;
}

const NO_SETTINGS: AutoCompactSettings = { window: null, enabled: null, percent: null };

/** "240000", 240000, "500k", "1m", or "200" for 200k; "auto" and anything else mean unset. */
const windowTokens = (value: unknown): number | null => {
  let tokens: number;
  if (typeof value === "number") tokens = value;
  else if (typeof value === "string") {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(value);
    if (match === null) return null;
    const unit = match[2]!.toLowerCase();
    tokens = Number(match[1]) * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1);
  } else return null;
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return Math.round(tokens < 1_000 ? tokens * 1_000 : tokens);
};

/** `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`: a percent in (0, 100], else unset. */
const compactPercent = (value: unknown): number | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const percent = Number.parseFloat(String(value));
  return Number.isFinite(percent) && percent > 0 && percent <= 100 ? percent : null;
};

const isTruthyEnv = (value: string | undefined) =>
  value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());

const managedSettingsPath = (): string => {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/managed-settings.json";
    case "win32":
      return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
    default:
      return "/etc/claude-code/managed-settings.json";
  }
};

/** The catalog's window for a transcript's model id, such as `claude-opus-5-5` or `…[1m]`. */
const modelWindow = (model: string | null): number | null => {
  if (model === null) return null;
  if (/\[1m\]$/i.test(model)) return 1_000_000;
  const slug = model.replace(/-\d{8}$/, "");
  return (
    resolveClaudeCatalogContextWindowTokens(BUNDLED_CLAUDE_MODEL_CATALOG, {
      instanceId: CLAUDE_INSTANCE,
      model: slug,
    }) ?? null
  );
};

export const makeClaudeContextWindow = () => {
  const userSettings = NodePath.join(NodeOS.homedir(), ".claude", "settings.json");
  const files = new Map<
    string,
    { checkedAtMs: number; mtimeMs: number | null; settings: AutoCompactSettings }
  >();

  // Re-stats a file at most every few seconds; re-parses it only when its mtime moves.
  const readSettings = (
    path: string,
  ): Effect.Effect<AutoCompactSettings, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const now = Date.now();
      const known = files.get(path);
      if (known !== undefined && now - known.checkedAtMs < RESTAT_MS) return known.settings;
      const mtimeMs = yield* statMtimeMs(path);
      let settings = NO_SETTINGS;
      if (mtimeMs !== null && known?.mtimeMs === mtimeMs) settings = known.settings;
      else if (mtimeMs !== null) {
        const record = parseJsonObject(((yield* readText(path)) ?? "").trim());
        const enabled: unknown = record?.autoCompactEnabled;
        settings = {
          window: windowTokens(record?.autoCompactWindow),
          enabled: typeof enabled === "boolean" ? enabled : null,
          percent: compactPercent(asRecord(record?.env)?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE),
        };
      }
      if (known === undefined && files.size >= MAX_CACHED_FILES) files.clear();
      files.set(path, { checkedAtMs: now, mtimeMs, settings });
      return settings;
    });

  /**
   * The session's window, or null when neither a setting nor the catalog
   * knows it. `cwd` adds the project's own settings files.
   */
  const resolve = (
    model: string | null,
    cwd: string | null,
  ): Effect.Effect<ClaudeContextWindow | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      // Highest precedence first, as the CLI merges them.
      const paths = [managedSettingsPath()];
      if (cwd !== null) {
        paths.push(NodePath.join(cwd, ".claude", "settings.local.json"));
        paths.push(NodePath.join(cwd, ".claude", "settings.json"));
      }
      paths.push(userSettings);
      let setWindow = windowTokens(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
      let enabled: boolean | null = null;
      let percent = compactPercent(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
      for (const path of paths) {
        const settings = yield* readSettings(path);
        setWindow ??= settings.window;
        enabled ??= settings.enabled;
        percent ??= settings.percent;
      }
      const max = modelWindow(model);
      const window = setWindow === null ? max : Math.min(setWindow, max ?? setWindow);
      if (window === null) return null;
      const autoCompactEnabled =
        enabled !== false && !isTruthyEnv(process.env.DISABLE_AUTO_COMPACT);
      let threshold =
        autoCompactEnabled && window > AUTO_COMPACT_BUFFER_TOKENS
          ? window - AUTO_COMPACT_BUFFER_TOKENS
          : null;
      if (threshold !== null && percent !== null) {
        threshold = Math.min(
          threshold,
          Math.floor((window - SUMMARY_OUTPUT_TOKENS) * (percent / 100)),
        );
      }
      return { window, autoCompactEnabled, autoCompactThreshold: threshold };
    });

  return { resolve };
};
