/**
 * Settings › Providers › Hermes Agent: which Hermes providers and models T3
 * offers, the T3 tools switch, plus Hermes's own config, keys and custom
 * endpoints, reached through the server's dashboard proxy. Hermes config is
 * global: Discord, cron and the CLI see every change made here. Fork add-on:
 * Hermes provider.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  AdvertisedEndpoint,
  EnvironmentId,
  HermesDashboardInput,
  ProviderInstanceId,
  ServerProviderModel,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { FoldedSettingsSection } from "../components/settings/FoldedSettingsSection";
import { SettingsRow } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { useStableCallback } from "../hooks/useStableCallback";
import { ensureLocalApi } from "../localApi";
import { desktopNetworkAccessStateAtom } from "../state/desktopNetworkAccess";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { HermesModelsSection } from "./HermesModelsSection";
import { hermesDashboard, hermesT3Tools, runHermes } from "./hermesSessions";

type Target = { readonly environmentId: EnvironmentId; readonly instanceId: ProviderInstanceId };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Calls one dashboard route; the response body, or null after an error toast. */
const dashboard = async (
  target: Target,
  method: HermesDashboardInput["method"],
  path: string,
  failureTitle: string,
  body?: unknown,
): Promise<unknown> => {
  const result = await runHermes(
    hermesDashboard,
    target.environmentId,
    { instanceId: target.instanceId, method, path, ...(body === undefined ? {} : { body }) },
    failureTitle,
  );
  return result === null ? null : result.body;
};

/** The row a dashboard section shows until its first load succeeds. */
function DashboardPendingRow(props: {
  readonly loadingTitle: string;
  readonly failed: boolean;
  readonly onRetry: () => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  if (!props.failed) {
    return <SettingsRow title={props.loadingTitle} description="Needs the dashboard URL above." />;
  }
  return (
    <SettingsRow
      title="Couldn't reach the Hermes dashboard"
      description="Check the dashboard URL above."
      control={
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void props.onRetry().finally(() => setRetrying(false));
          }}
        >
          {retrying ? "Retrying" : "Retry"}
        </Button>
      }
    />
  );
}

const NEEDS_MANAGE_ACCESS = "Needs provider management access on this connection.";

/** Stands in for a dashboard section the connection may not reach, so it never loads. */
function NeedsManageAccessRow(props: { readonly title: string }) {
  return <SettingsRow title={props.title} description={NEEDS_MANAGE_ACCESS} />;
}

export function HermesSettingsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  /** The instance's stored config, for the T3 tools switch. */
  readonly config: unknown;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly hiddenProviders: ReadonlyArray<string>;
  readonly onHiddenProvidersChange: (next: ReadonlyArray<string>) => void;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly onHiddenModelsChange: (
    next: ReadonlyArray<string>,
    affectedModels?: ReadonlyArray<string>,
  ) => void;
  readonly readOnly: boolean;
  readonly canWritePreferences: boolean;
}) {
  const target = { environmentId: props.environmentId, instanceId: props.instanceId };
  const id = `provider-instance-${props.instanceId}-hermes`;
  const mayUseDashboard = useAtomValue(hermesDashboard.permissionAtom(props.environmentId));
  const maySetT3Tools = useAtomValue(hermesT3Tools.permissionAtom(props.environmentId));
  const t3Tools = isRecord(props.config) && props.config.t3Tools === true;
  const t3ToolsUrl =
    isRecord(props.config) && typeof props.config.t3ToolsUrl === "string"
      ? props.config.t3ToolsUrl
      : "";
  return (
    <>
      <HermesModelsSection {...props} target={target} />
      <div
        inert={props.readOnly}
        aria-disabled={props.readOnly || undefined}
        className={props.readOnly ? "grid gap-6 opacity-50 select-none" : "grid gap-6"}
      >
        <FoldedSettingsSection
          id={`${id}-t3-tools`}
          title="T3 tools"
          summary={t3Tools ? "On · API server only" : "Off"}
        >
          <HermesT3Tools
            target={target}
            enabled={t3Tools}
            url={t3ToolsUrl}
            canChange={maySetT3Tools}
          />
        </FoldedSettingsSection>
        <FoldedSettingsSection
          id={`${id}-config`}
          title="Hermes config"
          summary="Global: Discord, cron and the CLI use it too"
        >
          {mayUseDashboard ? (
            <HermesConfigForm target={target} />
          ) : (
            <NeedsManageAccessRow title="Hermes config" />
          )}
        </FoldedSettingsSection>
        <FoldedSettingsSection id={`${id}-keys`} title="Hermes keys" summary="Write-only">
          {mayUseDashboard ? (
            <HermesKeys target={target} />
          ) : (
            <NeedsManageAccessRow title="Hermes keys" />
          )}
        </FoldedSettingsSection>
        <FoldedSettingsSection
          id={`${id}-endpoints`}
          title="Custom endpoints"
          summary="OpenAI-compatible gateways"
        >
          {mayUseDashboard ? (
            <HermesEndpoints target={target} />
          ) : (
            <NeedsManageAccessRow title="Custom endpoints" />
          )}
        </FoldedSettingsSection>
      </div>
    </>
  );
}

const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" || hostname === "[::1]" || hostname.startsWith("127.");

/** The T3 `/mcp` address Hermes is likely to reach: this Mac's Tailscale address first. */
const suggestedMcpUrl = (
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  isPrimary: boolean,
): string => {
  const available = (prefix: string) =>
    endpoints.find((endpoint) => endpoint.id.startsWith(prefix) && endpoint.status === "available");
  const endpoint = available("tailscale-magicdns:") ?? available("tailscale-ip:");
  if (endpoint !== undefined) return new URL("/mcp", endpoint.httpBaseUrl).href;
  const { protocol, hostname, origin } = window.location;
  return isPrimary && protocol.startsWith("http") && !isLoopbackHost(hostname)
    ? `${origin}/mcp`
    : "";
};

const isHttpUrl = (text: string) => {
  try {
    return ["http:", "https:"].includes(new URL(text).protocol);
  } catch {
    return false;
  }
};

/** Gives Hermes's API server T3's thread tools at the T3 address Hermes can reach. */
function HermesT3Tools(props: {
  readonly target: Target;
  readonly enabled: boolean;
  readonly url: string;
  readonly canChange: boolean;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isPrimary = props.target.environmentId === primaryEnvironmentId;
  const network = useEnvironmentQuery(
    window.desktopBridge && isPrimary ? desktopNetworkAccessStateAtom : null,
  );
  const suggested = suggestedMcpUrl(network.data?.advertisedEndpoints ?? [], isPrimary);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = (props.enabled ? props.url : (draft ?? (props.url || suggested))).trim();

  const toggle = async (enabled: boolean) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      enabled
        ? "Give Hermes T3 tools?\nT3 adds a t3-code MCP server to Hermes for its API server only, pins Discord, cron, the CLI and every other platform to no MCP servers, and restarts the Hermes gateway, so Discord drops for a moment."
        : "Take T3 tools away from Hermes?\nT3 removes the t3-code server and its key, puts back each platform's toolsets, and restarts the Hermes gateway, so Discord drops for a moment.",
    );
    if (!confirmed) return;
    setBusy(true);
    const result = await runHermes(
      hermesT3Tools,
      props.target.environmentId,
      { instanceId: props.target.instanceId, enabled, ...(enabled ? { url } : {}) },
      enabled ? "Could not turn on T3 tools" : "Could not turn off T3 tools",
    );
    setBusy(false);
    if (result === null) return;
    setDraft(null);
    toastManager.add({
      type: "success",
      title: enabled ? "T3 tools are on" : "T3 tools are off",
      description: result.restarted
        ? "The Hermes gateway is restarting."
        : "Hermes refused to restart its gateway, so it picks up the change on its own shortly.",
    });
  };

  return (
    <SettingsRow
      title="T3 tools"
      description={
        props.canChange
          ? "Lets Hermes start and steer T3 coworker threads while one of its T3 threads runs a turn. Only Hermes's API server gets them."
          : NEEDS_MANAGE_ACCESS
      }
      control={
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            className="w-64"
            placeholder="https://<mac>.ts.net/mcp"
            aria-label="T3 address Hermes uses"
            spellCheck={false}
            disabled={!props.canChange || props.enabled || busy}
            value={url}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Switch
            aria-label="T3 tools"
            checked={props.enabled}
            disabled={!props.canChange || busy || (!props.enabled && !isHttpUrl(url))}
            onCheckedChange={(checked) => void toggle(checked)}
          />
        </div>
      }
    />
  );
}

interface SchemaField {
  readonly type: string;
  readonly description: string;
  readonly category: string;
  readonly options?: ReadonlyArray<string>;
}

const readPath = (config: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), config);

/** The changed dotted paths as the nested object Hermes deep-merges. */
const nestedPatch = (changes: ReadonlyMap<string, unknown>) => {
  const root: Record<string, unknown> = {};
  for (const [path, value] of changes) {
    const keys = path.split(".");
    let node = root;
    for (const key of keys.slice(0, -1)) {
      const child = node[key];
      node = isRecord(child) ? child : (node[key] = {});
    }
    node[keys.at(-1)!] = value;
  }
  return root;
};

const parseField = (field: SchemaField, raw: string): { value: unknown } | { error: string } => {
  if (field.type === "number") {
    const value = Number(raw);
    return raw.trim() !== "" && Number.isFinite(value) ? { value } : { error: "Enter a number." };
  }
  if (field.type === "list" || field.type === "object") {
    try {
      const value: unknown = JSON.parse(raw);
      const ok = field.type === "list" ? Array.isArray(value) : isRecord(value);
      return ok
        ? { value }
        : { error: `Enter a JSON ${field.type === "list" ? "array" : "object"}.` };
    } catch {
      return { error: "Enter valid JSON." };
    }
  }
  return { value: raw };
};

const displayValue = (field: SchemaField, value: unknown): string =>
  field.type === "list" || field.type === "object"
    ? JSON.stringify(value ?? (field.type === "list" ? [] : {}))
    : value === undefined || value === null
      ? ""
      : String(value);

/** Hermes's schema-driven config form, one category at a time. */
function HermesConfigForm(props: { readonly target: Target }) {
  const [schema, setSchema] = useState<{
    readonly fields: ReadonlyArray<readonly [string, SchemaField]>;
    readonly categories: ReadonlyArray<string>;
  } | null>(null);
  const [config, setConfig] = useState<unknown>(null);
  const [failed, setFailed] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [changes, setChanges] = useState<ReadonlyMap<string, unknown>>(new Map());
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const [saving, setSaving] = useState(false);

  const load = useStableCallback(async () => {
    const [schemaBody, configBody] = await Promise.all([
      dashboard(
        props.target,
        "GET",
        "/api/config/schema",
        "Could not load the Hermes config schema",
      ),
      dashboard(props.target, "GET", "/api/config", "Could not load the Hermes config"),
    ]);
    if (!isRecord(schemaBody) || !isRecord(schemaBody.fields) || configBody === null) {
      setFailed(true);
      return;
    }
    setFailed(false);
    const fields = Object.entries(schemaBody.fields).flatMap(([path, entry]) =>
      isRecord(entry) && typeof entry.type === "string"
        ? [
            [
              path,
              {
                type: entry.type,
                description: typeof entry.description === "string" ? entry.description : path,
                category: typeof entry.category === "string" ? entry.category : "general",
                ...(Array.isArray(entry.options)
                  ? {
                      options: entry.options.filter(
                        (option): option is string => typeof option === "string",
                      ),
                    }
                  : {}),
              },
            ] as const,
          ]
        : [],
    );
    const present = new Set(fields.map(([, field]) => field.category));
    const ordered = Array.isArray(schemaBody.category_order)
      ? schemaBody.category_order.filter(
          (entry): entry is string => typeof entry === "string" && present.has(entry),
        )
      : [];
    const categories = [
      ...ordered,
      ...[...present].filter((entry) => !ordered.includes(entry)).toSorted(),
    ];
    setSchema({ fields, categories });
    setConfig(configBody);
    setCategory((current) => current ?? categories[0] ?? null);
    setChanges(new Map());
    setDrafts(new Map());
  });

  useEffect(() => {
    void load();
  }, [load, props.target.environmentId, props.target.instanceId]);

  if (schema === null) {
    return (
      <DashboardPendingRow loadingTitle="Loading Hermes config" failed={failed} onRetry={load} />
    );
  }

  const query = filter.trim().toLowerCase();
  const visible = schema.fields.filter(([path, field]) =>
    query === ""
      ? field.category === category
      : path.toLowerCase().includes(query) || field.description.toLowerCase().includes(query),
  );
  const valueOf = (path: string) =>
    changes.has(path) ? changes.get(path) : readPath(config, path);
  const change = (path: string, value: unknown) =>
    setChanges((previous) => new Map(previous).set(path, value));
  const commitDraft = (path: string, field: SchemaField) => {
    const raw = drafts.get(path);
    if (raw === undefined) return;
    const parsed = parseField(field, raw);
    if ("error" in parsed) {
      toastManager.add({ type: "error", title: path, description: parsed.error });
      return;
    }
    change(path, parsed.value);
  };

  const save = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Save ${changes.size} Hermes setting${changes.size === 1 ? "" : "s"}?\nThis changes Hermes everywhere, including Discord and cron.`,
    );
    if (!confirmed) return;
    setSaving(true);
    const result = await dashboard(
      props.target,
      "PUT",
      "/api/config",
      "Could not save the Hermes config",
      {
        config: nestedPatch(changes),
      },
    );
    setSaving(false);
    if (result === null) return;
    toastManager.add({ type: "success", title: "Hermes config saved" });
    await load();
  };

  return (
    <>
      <SettingsRow
        title="Category"
        description="Changes apply to Hermes on its host, for every chat and job."
        control={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              size="sm"
              className="w-40"
              placeholder="Search settings"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <Select
              value={category ?? ""}
              onValueChange={(value) => value !== null && setCategory(value)}
            >
              <SelectTrigger aria-label="Hermes config category" className="w-36" size="sm">
                <SelectValue>{category}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {schema.categories.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {entry}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              type="button"
              size="sm"
              disabled={changes.size === 0 || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving" : changes.size > 0 ? `Save (${changes.size})` : "Save"}
            </Button>
          </div>
        }
      />
      {visible.map(([path, field]) => {
        const value = valueOf(path);
        const control =
          field.type === "boolean" ? (
            <Switch
              aria-label={path}
              checked={value === true}
              onCheckedChange={(checked) => change(path, checked)}
            />
          ) : field.type === "select" && field.options !== undefined ? (
            <Select
              value={displayValue(field, value)}
              onValueChange={(next) => next !== null && change(path, next)}
            >
              <SelectTrigger aria-label={path} className="w-48" size="sm">
                <SelectValue>{displayValue(field, value) || "Default"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {field.options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option || "Default"}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : (
            <Input
              size="sm"
              className="w-56"
              aria-label={path}
              spellCheck={false}
              value={drafts.get(path) ?? displayValue(field, value)}
              onChange={(event) =>
                setDrafts((previous) => new Map(previous).set(path, event.target.value))
              }
              onBlur={() => commitDraft(path, field)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitDraft(path, field);
              }}
            />
          );
        return (
          <SettingsRow
            key={path}
            title={<code className="text-xs">{path}</code>}
            description={field.description}
            status={changes.has(path) ? "Unsaved" : undefined}
            control={control}
          />
        );
      })}
    </>
  );
}

interface EnvKey {
  readonly name: string;
  readonly isSet: boolean;
  readonly description: string;
  readonly label: string;
}

/** Hermes's `.env` keys: set or remove, never read back. */
function HermesKeys(props: { readonly target: Target }) {
  const [keys, setKeys] = useState<ReadonlyArray<EnvKey> | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useStableCallback(async () => {
    const body = await dashboard(props.target, "GET", "/api/env", "Could not load Hermes keys");
    if (!isRecord(body)) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setKeys(
      Object.entries(body)
        .flatMap(([name, entry]) =>
          isRecord(entry) && entry.channel_managed !== true
            ? [
                {
                  name,
                  isSet: entry.is_set === true,
                  description: typeof entry.description === "string" ? entry.description : "",
                  label:
                    typeof entry.provider_label === "string" && entry.provider_label !== ""
                      ? entry.provider_label
                      : typeof entry.category === "string"
                        ? entry.category
                        : "",
                },
              ]
            : [],
        )
        .toSorted(
          (left, right) =>
            Number(right.isSet) - Number(left.isSet) || left.name.localeCompare(right.name),
        ),
    );
  });

  useEffect(() => {
    void load();
  }, [load, props.target.environmentId, props.target.instanceId]);

  const setKey = async (name: string, value: string) => {
    if (value === "") return;
    setBusy(name);
    const result = await dashboard(props.target, "PUT", "/api/env", `Could not set ${name}`, {
      key: name,
      value,
    });
    setBusy(null);
    if (result === null) return;
    setDrafts((previous) => {
      const next = new Map(previous);
      next.delete(name);
      return next;
    });
    toastManager.add({ type: "success", title: `${name} saved` });
    await load();
  };

  const removeKey = async (name: string) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(`Remove ${name} from Hermes?`, {
      variant: "destructive",
    });
    if (!confirmed) return;
    setBusy(name);
    const result = await dashboard(props.target, "DELETE", "/api/env", `Could not remove ${name}`, {
      key: name,
    });
    setBusy(null);
    if (result !== null) await load();
  };

  if (keys === null) {
    return (
      <DashboardPendingRow loadingTitle="Loading Hermes keys" failed={failed} onRetry={load} />
    );
  }
  const query = filter.trim().toLowerCase();
  const visible = keys.filter(
    (key) =>
      (query === "" ? key.isSet : true) &&
      (query === "" ||
        key.name.toLowerCase().includes(query) ||
        key.label.toLowerCase().includes(query) ||
        key.description.toLowerCase().includes(query)),
  );
  const addName = newName.trim().toUpperCase();

  return (
    <>
      <SettingsRow
        title="Keys"
        description="Values are never shown here. Search to find a key that is not set yet."
        control={
          <Input
            size="sm"
            className="w-48"
            placeholder="Search keys"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        }
      />
      {visible.map((key) => (
        <SettingsRow
          key={key.name}
          title={<code className="text-xs">{key.name}</code>}
          description={[key.label, key.description].filter(Boolean).join(" · ") || undefined}
          status={key.isSet ? "Set" : "Not set"}
          control={
            <div className="flex items-center gap-1">
              <Input
                size="sm"
                type="password"
                autoComplete="off"
                className="w-44"
                placeholder={key.isSet ? "Replace value" : "Value"}
                aria-label={`${key.name} value`}
                value={drafts.get(key.name) ?? ""}
                onChange={(event) =>
                  setDrafts((previous) => new Map(previous).set(key.name, event.target.value))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") void setKey(key.name, drafts.get(key.name) ?? "");
                }}
              />
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy !== null || (drafts.get(key.name) ?? "") === ""}
                onClick={() => void setKey(key.name, drafts.get(key.name) ?? "")}
              >
                Save
              </Button>
              {key.isSet ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-destructive"
                  disabled={busy !== null}
                  onClick={() => void removeKey(key.name)}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          }
        />
      ))}
      <SettingsRow
        title="Add a key"
        description="Any name Hermes reads from its .env file."
        control={
          <div className="flex items-center gap-1">
            <Input
              size="sm"
              className="w-40"
              placeholder="NAME"
              spellCheck={false}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              className="w-40"
              placeholder="Value"
              aria-label="New key value"
              value={drafts.get("\u0000new") ?? ""}
              onChange={(event) =>
                setDrafts((previous) => new Map(previous).set("\u0000new", event.target.value))
              }
            />
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={
                busy !== null || !/^[A-Z_][A-Z0-9_]*$/.test(addName) || !drafts.get("\u0000new")
              }
              onClick={() =>
                void setKey(addName, drafts.get("\u0000new") ?? "").then(() => {
                  setNewName("");
                  setDrafts((previous) => {
                    const next = new Map(previous);
                    next.delete("\u0000new");
                    return next;
                  });
                })
              }
            >
              Add
            </Button>
          </div>
        }
      />
    </>
  );
}

interface Endpoint {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly modelCount: number;
  readonly hasApiKey: boolean;
  readonly isCurrent: boolean;
}

const EMPTY_ENDPOINT_DRAFT = { name: "", baseUrl: "", model: "", apiKey: "" };

/** OpenAI-compatible endpoints Hermes routes to, such as a free gateway. */
function HermesEndpoints(props: { readonly target: Target }) {
  const [endpoints, setEndpoints] = useState<ReadonlyArray<Endpoint> | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState(EMPTY_ENDPOINT_DRAFT);
  const [busy, setBusy] = useState(false);

  const load = useStableCallback(async () => {
    const body = await dashboard(
      props.target,
      "GET",
      "/api/providers/custom-endpoints",
      "Could not load custom endpoints",
    );
    if (!isRecord(body) || !Array.isArray(body.endpoints)) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setEndpoints(
      body.endpoints.flatMap((entry) =>
        isRecord(entry) && typeof entry.id === "string"
          ? [
              {
                id: entry.id,
                name: typeof entry.name === "string" ? entry.name : entry.id,
                baseUrl: typeof entry.base_url === "string" ? entry.base_url : "",
                model: typeof entry.model === "string" ? entry.model : "",
                modelCount: Array.isArray(entry.models) ? entry.models.length : 0,
                hasApiKey: entry.has_api_key === true,
                isCurrent: entry.is_current === true,
              },
            ]
          : [],
      ),
    );
  });

  useEffect(() => {
    void load();
  }, [load, props.target.environmentId, props.target.instanceId]);

  const run = async (
    method: HermesDashboardInput["method"],
    path: string,
    title: string,
    body?: unknown,
  ) => {
    setBusy(true);
    const result = await dashboard(props.target, method, path, title, body);
    setBusy(false);
    if (result !== null) await load();
    return result !== null;
  };

  const add = async () => {
    const ok = await run("POST", "/api/providers/custom-endpoints", "Could not add the endpoint", {
      name: draft.name.trim(),
      base_url: draft.baseUrl.trim(),
      model: draft.model.trim(),
      ...(draft.apiKey === "" ? {} : { api_key: draft.apiKey }),
      discover_models: true,
    });
    if (ok) setDraft(EMPTY_ENDPOINT_DRAFT);
  };

  const remove = async (endpoint: Endpoint) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove the ${endpoint.name} endpoint from Hermes?`,
      {
        variant: "destructive",
      },
    );
    if (confirmed) {
      await run(
        "DELETE",
        `/api/providers/custom-endpoints/${endpoint.id}`,
        "Could not remove the endpoint",
      );
    }
  };

  const makeDefault = async (endpoint: Endpoint) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Make ${endpoint.name} Hermes's default model?\nDiscord and cron use the default too.`,
    );
    if (confirmed) {
      await run(
        "POST",
        `/api/providers/custom-endpoints/${endpoint.id}/activate`,
        "Could not make the endpoint the default",
      );
    }
  };

  if (endpoints === null) {
    return <DashboardPendingRow loadingTitle="Loading endpoints" failed={failed} onRetry={load} />;
  }
  const canAdd =
    draft.name.trim() !== "" &&
    /^https?:\/\//.test(draft.baseUrl.trim()) &&
    draft.model.trim() !== "";

  return (
    <>
      {endpoints.map((endpoint) => (
        <SettingsRow
          key={endpoint.id}
          title={endpoint.name}
          description={`${endpoint.baseUrl} · ${endpoint.model || "no model"} · ${endpoint.modelCount} model${endpoint.modelCount === 1 ? "" : "s"}${endpoint.hasApiKey ? " · key set" : " · no key"}`}
          status={endpoint.isCurrent ? "Default" : undefined}
          control={
            <div className="flex items-center gap-1">
              {!endpoint.isCurrent ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  disabled={busy}
                  onClick={() => void makeDefault(endpoint)}
                >
                  Make default
                </Button>
              ) : null}
              <Button
                type="button"
                size="xs"
                variant="ghost-destructive"
                disabled={busy}
                onClick={() => void remove(endpoint)}
              >
                Remove
              </Button>
            </div>
          }
        />
      ))}
      <SettingsRow
        title="Add an endpoint"
        description="Hermes lists its models. Leave the key blank for a gateway that needs none."
        control={
          <div className="grid grid-cols-2 gap-1">
            <Input
              size="sm"
              placeholder="Name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <Input
              size="sm"
              placeholder="https://gateway/v1"
              spellCheck={false}
              value={draft.baseUrl}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
            <Input
              size="sm"
              placeholder="Model"
              spellCheck={false}
              value={draft.model}
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            />
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              placeholder="API key (optional)"
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            />
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="col-span-2"
              disabled={busy || !canAdd}
              onClick={() => void add()}
            >
              Add endpoint
            </Button>
          </div>
        }
      />
    </>
  );
}
