/**
 * Turns Hermes's `/api/model/options` into T3 models: one entry per
 * `provider::model`, grouped by provider in the picker, plus "Hermes
 * default", which sends no model so Hermes uses its own configured one.
 */
import { HERMES_DEFAULT_MODEL, type ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

const REASONING_EFFORT_LABELS = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
} as const;
export const DEFAULT_REASONING_EFFORT = "medium";

/**
 * Providers T3 never offers through Hermes. Anthropic's terms do not allow
 * its subscription models behind another agent, whatever provider routes them.
 */
const BLOCKED_PROVIDERS = new Set(["anthropic", "claude", "claude-code"]);
const BLOCKED_MODEL = /claude|anthropic|lyria/i;
/** Google sign-ins (Gemini CLI, Antigravity) are for Google's own clients; API keys are fine. */
const isGoogleSignIn = (slug: string, authType: string) =>
  /gemini|google|antigravity/i.test(slug) && /oauth|cli|login/i.test(authType);
/** Kilo's gateway serves paid models too; T3 offers only its free ones, which need no key. */
const isKilo = (slug: string, name: string) => /kilo/i.test(slug) || /kilo/i.test(name);
const isFreeModel = (model: string) =>
  /:free$/i.test(model) || model === "kilo-auto/free" || model === "openrouter/free";

export const isBlockedHermesProvider = (slug: string) => BLOCKED_PROVIDERS.has(slug.toLowerCase());

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface HermesProviderOption {
  readonly slug: string;
  readonly name: string;
  readonly authenticated: boolean;
  readonly authType: string;
  readonly isCurrent: boolean;
  readonly models: ReadonlyArray<string>;
  readonly capabilities: Readonly<
    Record<
      string,
      { readonly fast: boolean; readonly reasoning: boolean; readonly canDisableReasoning: boolean }
    >
  >;
}

/** The providers Hermes reports, before T3's filters. */
export const decodeHermesProviders = (body: unknown): ReadonlyArray<HermesProviderOption> =>
  (isRecord(body) && Array.isArray(body.providers) ? body.providers : []).flatMap(
    (entry): HermesProviderOption[] => {
      if (!isRecord(entry) || typeof entry.slug !== "string") return [];
      const capabilities = isRecord(entry.capabilities) ? entry.capabilities : {};
      return [
        {
          slug: entry.slug,
          name: typeof entry.name === "string" && entry.name ? entry.name : entry.slug,
          authenticated: entry.authenticated === true,
          authType: typeof entry.auth_type === "string" ? entry.auth_type : "",
          isCurrent: entry.is_current === true,
          models: Array.isArray(entry.models)
            ? entry.models.filter((model): model is string => typeof model === "string")
            : [],
          capabilities: Object.fromEntries(
            Object.entries(capabilities).flatMap(([model, value]) =>
              isRecord(value)
                ? [
                    [
                      model,
                      {
                        fast: value.fast === true,
                        reasoning: value.reasoning === true,
                        canDisableReasoning: value.can_disable_reasoning === true,
                      },
                    ],
                  ]
                : [],
            ),
          ),
        },
      ];
    },
  );

/** Whether T3 may offer this provider at all; the Settings checklist shows the rest as locked. */
export const isOfferableHermesProvider = (provider: HermesProviderOption) =>
  !isBlockedHermesProvider(provider.slug) && !isGoogleSignIn(provider.slug, provider.authType);

const modelCapabilities = (
  capability: HermesProviderOption["capabilities"][string] | undefined,
) => {
  if (!capability) return null;
  const efforts = Object.keys(REASONING_EFFORT_LABELS).filter(
    (effort) => effort !== "none" || capability.canDisableReasoning,
  ) as Array<keyof typeof REASONING_EFFORT_LABELS>;
  return createModelCapabilities({
    optionDescriptors: [
      ...(capability.reasoning
        ? [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select" as const,
              currentValue: DEFAULT_REASONING_EFFORT,
              options: efforts.map((id) => ({
                id,
                label: REASONING_EFFORT_LABELS[id],
                ...(id === DEFAULT_REASONING_EFFORT ? { isDefault: true } : {}),
              })),
            },
          ]
        : []),
      ...(capability.fast
        ? [{ id: "fastMode", label: "Fast Mode", type: "boolean" as const }]
        : []),
    ],
  });
};

export const HERMES_DEFAULT_MODEL_ENTRY: ServerProviderModel = {
  slug: HERMES_DEFAULT_MODEL,
  name: "Hermes default",
  isCustom: false,
  isDefault: true,
  capabilities: null,
};

/**
 * The capabilities of the model Hermes is configured with. The payload names it
 * beside `providers` as `model` and `provider` (config `model.default`); its
 * capabilities are that provider's entry for the model. Null when either is
 * missing, so "Hermes default" then shows no traits rather than guessed ones.
 */
const hermesDefaultCapabilities = (
  body: unknown,
  providers: ReadonlyArray<HermesProviderOption>,
) => {
  if (!isRecord(body) || typeof body.model !== "string" || !body.model) return null;
  const providerSlug = typeof body.provider === "string" ? body.provider.toLowerCase() : "";
  const current =
    providers.find((provider) => provider.slug.toLowerCase() === providerSlug) ??
    providers.find((provider) => provider.isCurrent);
  return modelCapabilities(current?.capabilities[body.model]);
};

/** Every model of every signed-in provider T3 may offer, minus the ones the user hid. */
export function hermesModelsFromOptions(
  body: unknown,
  hiddenProviders: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const hidden = new Set(hiddenProviders.map((slug) => slug.toLowerCase()));
  const seen = new Set<string>([HERMES_DEFAULT_MODEL]);
  const providers = decodeHermesProviders(body);
  const models: Array<ServerProviderModel> = [
    { ...HERMES_DEFAULT_MODEL_ENTRY, capabilities: hermesDefaultCapabilities(body, providers) },
  ];
  for (const provider of providers) {
    if (!provider.authenticated && !isKilo(provider.slug, provider.name)) continue;
    if (!isOfferableHermesProvider(provider) || hidden.has(provider.slug.toLowerCase())) continue;
    const kilo = isKilo(provider.slug, provider.name);
    for (const model of provider.models) {
      if (BLOCKED_MODEL.test(model) || (kilo && !isFreeModel(model))) continue;
      const slug = `${provider.slug}::${model}`;
      if (seen.has(slug)) continue;
      seen.add(slug);
      models.push({
        slug,
        name: model,
        subProvider: provider.name,
        isCustom: false,
        capabilities: modelCapabilities(provider.capabilities[model]),
      });
    }
  }
  return models;
}

/** Refuses a slug that names a blocked provider or model, whatever the catalog said. */
export function isBlockedHermesModel(slug: string): boolean {
  const { provider, model } = hermesRunModel(slug);
  return (
    (provider !== undefined && isBlockedHermesProvider(provider)) || BLOCKED_MODEL.test(model ?? "")
  );
}

/** Splits a T3 model slug back into what `/v1/runs` takes; "default" sends neither. */
export function hermesRunModel(slug: string): {
  readonly provider?: string;
  readonly model?: string;
} {
  if (slug === HERMES_DEFAULT_MODEL || slug === "hermes-agent") return {};
  const separator = slug.indexOf("::");
  return separator < 0
    ? { model: slug }
    : { provider: slug.slice(0, separator), model: slug.slice(separator + 2) };
}
