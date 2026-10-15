/**
 * Brand names for providers and models that agent gateways report by id, so
 * Hermes and Pi rows read like the vendor's own picker: "Codex" and
 * "GPT-6.1-Sol" rather than "openai-codex" and "gpt-6.1-sol".
 * Fork add-on: provider and model brand names.
 *
 * @module modelBrandNames
 */
import { formatCodexModelName } from "./model.ts";

/**
 * Gateway provider ids by the name T3 shows elsewhere. A subscription sign-in
 * and an API key for the same vendor stay apart ("Codex" and "OpenAI",
 * "Grok" and "xAI"), so two signed-in routes never share a label.
 */
const PROVIDER_BRANDS: Readonly<Record<string, string>> = {
  "openai-codex": "Codex",
  openai: "OpenAI",
  "openai-api": "OpenAI",
  gemini: "Gemini",
  google: "Gemini",
  "google-gemini-cli": "Gemini CLI",
  "google-antigravity": "Antigravity",
  "google-vertex": "Vertex AI",
  vertex: "Vertex AI",
  "xai-oauth": "Grok",
  xai: "xAI",
  anthropic: "Claude",
  openrouter: "OpenRouter",
  "kilo-gateway": "Kilo",
  kilo: "Kilo",
  nvidia: "NVIDIA",
  "github-copilot": "GitHub Copilot",
  copilot: "GitHub Copilot",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  huggingface: "Hugging Face",
};

/** The brand for a gateway provider id; the gateway's own name when T3 has none. */
export function brandProviderName(slug: string, reportedName?: string): string {
  return PROVIDER_BRANDS[slug.toLowerCase()] ?? (reportedName?.trim() || slug);
}

/** Words whose vendor casing a plain capital would get wrong. */
const WORDS: Readonly<Record<string, string>> = {
  gpt: "GPT",
  glm: "GLM",
  lfm: "LFM",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  mimo: "MiMo",
  flashx: "FlashX",
  ultraspeed: "UltraSpeed",
};

/** Router ids whose model part says nothing on its own. */
const ROUTER_NAMES: Readonly<Record<string, string>> = {
  "kilo-auto/free": "Kilo Auto",
  "openrouter/free": "OpenRouter Free",
};

/** Prefix words the vendor hyphenates to the next one: "Multi-Agent", "Flash-Lite". */
const HYPHENATED: Readonly<Record<string, string>> = {
  multi: "agent",
  non: "reasoning",
  flash: "lite",
};

function formatWord(word: string): string {
  const known = WORDS[word.toLowerCase()];
  if (known) return known;
  // OpenAI's reasoning series stays lowercase: o3, o4-mini.
  if (/^o\d/i.test(word)) return word.toLowerCase();
  // Sizes and versioned letters: 550b, 2.6b, a55b, v4, k3, m3.
  if (/^(?:\d+(?:\.\d+)?[bkm]|[a-z]\d+(?:\.\d+)?b?)$/i.test(word)) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function formatWords(words: ReadonlyArray<string>): string {
  const parts: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const next = words[index + 1];
    if (next !== undefined && HYPHENATED[word.toLowerCase()] === next.toLowerCase()) {
      parts.push(`${formatWord(word)}-${formatWord(next)}`);
      index += 1;
    } else {
      parts.push(formatWord(word));
    }
  }
  return parts.join(" ");
}

/** "gpt-6-sol-900k" reads "GPT-6-Sol (900K)", as OpenAI writes its picker names. */
function formatGptName(id: string): string {
  const context = /^(.*)-(\d+k)$/i.exec(id);
  return context
    ? `${formatCodexModelName(context[1]!)} (${context[2]!.toUpperCase()})`
    : formatCodexModelName(id);
}

function formatBareModel(id: string): string {
  const words = id.split("-").filter(Boolean);
  const family = words[0]?.toLowerCase();
  if (family === "gpt" && /^\d/.test(words[1] ?? "")) return formatGptName(id);
  // xAI names its dated builds without the date: "Grok 4.20 Reasoning".
  if (family === "grok") return formatWords(words.filter((word) => !/^\d{4}$/.test(word)));
  // Zhipu writes "GLM-5.3".
  if (family === "glm" && /^\d/.test(words[1] ?? "")) {
    return [`GLM-${words[1]}`, formatWords(words.slice(2))].filter(Boolean).join(" ");
  }
  return formatWords(words);
}

/**
 * A model id the way its vendor names it: "gpt-6.1-sol" reads "GPT-6.1-Sol",
 * "grok-4.20-0309-reasoning" reads "Grok 4.20 Reasoning", and a router's
 * "vendor/model" drops the vendor. A `:free` tier is marked, except under Kilo,
 * where T3 offers only free models.
 */
export function brandModelName(providerSlug: string, modelId: string): string {
  const free = /:free$/i.test(modelId);
  const id = free ? modelId.slice(0, -":free".length) : modelId;
  const name =
    ROUTER_NAMES[modelId.toLowerCase()] ?? formatBareModel(id.slice(id.lastIndexOf("/") + 1));
  return free && !/kilo/i.test(providerSlug) ? `${name} (free)` : name;
}

/**
 * A Pi model's name: the name Pi reports, except Codex subscription models,
 * which take OpenAI's own spelling so they match T3's Codex provider.
 */
export function brandPiModelName(
  providerSlug: string,
  modelId: string,
  reportedName: string | undefined,
): string {
  if (providerSlug.toLowerCase() === "openai-codex" && /^gpt-\d/i.test(modelId)) {
    return formatGptName(modelId);
  }
  return reportedName ?? `${providerSlug}/${modelId}`;
}
