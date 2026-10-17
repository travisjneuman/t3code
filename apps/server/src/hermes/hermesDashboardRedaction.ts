/**
 * What the Hermes dashboard proxy hides before a response reaches a client,
 * and how a save puts the hidden values back. A field is secret by what its
 * name means (`api_key`, `bearerToken`, `X-Auth-Token`, `client_secret`,
 * `Authorization`, `cookie`), not by a substring, so `max_tokens`,
 * `token_limit`, `api_key_env` and `has_api_key` stay as they are. Header maps
 * hide every value, a `{name, value}` pair hides the value of a secret name,
 * and credentials inside an otherwise plain string (a URL's password or
 * secret query parameter, a `Bearer` value, a well-known key shape) are
 * hidden in place. Fork add-on: Hermes provider.
 *
 * @module hermes/hermesDashboardRedaction
 */

export const REDACTED = "••••••";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `apiKey`, `api_key`, `X-Api-Key` and `tts.elevenlabs.api_key` all end in `api`, `key`. */
const wordsOf = (key: string): ReadonlyArray<string> =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");

const SECRET_NOUNS: ReadonlySet<string> = new Set([
  "token",
  "secret",
  "secrets",
  "password",
  "passwords",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "authorization",
  "cookie",
  "cookies",
  "bearer",
  "dsn",
  "apikey",
  "apikeys",
  "privatekey",
  "secretkey",
  "accesskey",
  "signingkey",
  "masterkey",
  "licensekey",
  "encryptionkey",
]);
/** Run-together names such as `authtoken`, `clientsecret` or `dbpassword`. */
const SECRET_SUFFIXES = ["token", "secret", "password", "passwd", "passphrase"];
/** A bare `key` names a secret only after one of these: `api_key`, `private_key`. */
const KEY_QUALIFIERS: ReadonlySet<string> = new Set([
  "api",
  "access",
  "secret",
  "private",
  "signing",
  "encryption",
  "master",
  "license",
  "client",
  "app",
  "auth",
  "service",
  "session",
  "webhook",
  "bot",
  "deploy",
  "ssh",
]);
/** `tokens` is usually a count (`max_tokens`); these make it a list of credentials. */
const TOKEN_QUALIFIERS: ReadonlySet<string> = new Set([
  "api",
  "access",
  "auth",
  "bearer",
  "refresh",
  "session",
  "bot",
]);

/** The head noun decides: `token_limit` is a limit, `refresh_token` is a token. */
const namesSecret = (words: ReadonlyArray<string>): boolean => {
  const last = words.at(-1);
  const before = words.at(-2);
  if (last === undefined) return false;
  if (SECRET_NOUNS.has(last)) return true;
  if (last === "key" || last === "keys") return before !== undefined && KEY_QUALIFIERS.has(before);
  if (last === "tokens") return before !== undefined && TOKEN_QUALIFIERS.has(before);
  // Discord and Slack webhook URLs carry their token in the path.
  if (last === "url") return before === "webhook";
  return SECRET_SUFFIXES.some((suffix) => last.length > suffix.length && last.endsWith(suffix));
};

export const isSecretKey = (key: string): boolean => namesSecret(wordsOf(key));

/** Header names carry no reliable convention (`X-Goog-Api-Key`, `X-Plex-Token`, `Foo`). */
const isHeaderMap = (key: string): boolean => wordsOf(key).at(-1) === "headers";

/**
 * Hermes's own partial reveals (`api_key_preview`, `redacted_value`), dropped
 * outright: a few clear characters of a key match no shape `redactText` knows.
 */
const isRevealKey = (key: string): boolean => {
  const words = wordsOf(key);
  const joined = words.join("_");
  if (joined === "redacted_value" || joined === "masked_value") return true;
  if (words.at(-1) !== "preview") return false;
  const named = words.slice(0, -1);
  return named.includes("key") || namesSecret(named);
};

const PAIR_NAME_FIELDS = ["name", "key", "header", "env", "variable"] as const;

/** `{name: "OPENAI_API_KEY", value: "…"}` and `{header: "Authorization", value: "…"}`. */
const pairNamesSecret = (record: Record<string, unknown>): boolean =>
  PAIR_NAME_FIELDS.some((field) => {
    const name = record[field];
    return typeof name === "string" && isSecretKey(name);
  });

/** Fields of a secret-named object that hold that secret: `api_key: {value, default}`. */
const SECRET_HOLDER_FIELDS: ReadonlySet<string> = new Set(["value", "default"]);

const AUTH_SCHEME_VALUE = /^(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{16,}$/i;
const URL_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:)[^\s/?#@]+@/i;
const URL_QUERY_PARAM = /([?&])([^=&#\s]+)=([^&#\s]+)/g;
const KNOWN_KEY_SHAPE =
  /^(?:sk-[\w-]{16,}|sk_(?:live|test)_\w{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+)$/;

/** A plain field's text with any credential inside it hidden, the rest kept. */
const redactText = (text: string): string => {
  if (KNOWN_KEY_SHAPE.test(text)) return REDACTED;
  const scheme = AUTH_SCHEME_VALUE.exec(text);
  if (scheme !== null) return `${scheme[1]}${scheme[2]}${REDACTED}`;
  if (!URL_PREFIX.test(text)) return text;
  return text
    .replace(URL_USERINFO, (_match, prefix: string) => `${prefix}${REDACTED}@`)
    .replace(URL_QUERY_PARAM, (match, separator: string, name: string) =>
      name.toLowerCase() === "key" || isSecretKey(name) ? `${separator}${name}=${REDACTED}` : match,
    );
};

/**
 * A YAML password written unquoted arrives as a number, so a secret number is
 * hidden too. Booleans and null only say whether something is set.
 */
const redactLeaf = (value: unknown, secret: boolean): unknown => {
  if (typeof value === "string") {
    if (value.length === 0) return value;
    return secret ? REDACTED : redactText(value);
  }
  if (typeof value === "number") return secret ? REDACTED : value;
  return value;
};

/** Whether a record's field holds a secret, by its own name or its record's. */
const fieldIsSecret = (
  record: Record<string, unknown>,
  key: string,
  context: { readonly valuesSecret: boolean; readonly holderSecret: boolean },
): boolean =>
  context.valuesSecret ||
  isSecretKey(key) ||
  isHeaderMap(key) ||
  (key === "value" && pairNamesSecret(record)) ||
  (context.holderSecret && SECRET_HOLDER_FIELDS.has(key));

const redactRecord = (
  record: Record<string, unknown>,
  context: { readonly valuesSecret: boolean; readonly holderSecret: boolean },
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).flatMap(([key, child]): Array<[string, unknown]> => {
      if (isRevealKey(key)) return [];
      if (isRecord(child) && isHeaderMap(key)) {
        return [[key, redactRecord(child, { valuesSecret: true, holderSecret: false })]];
      }
      return [[key, redactNode(child, fieldIsSecret(record, key, context))]];
    }),
  );

/**
 * A secret name hides the strings and numbers under it, through arrays. An
 * object under one keeps its own fields' meaning, so a config schema keyed by
 * `tts.elevenlabs.api_key` keeps its `type` and `description`, while the
 * secret's own `value` or `default` stays hidden.
 */
const redactNode = (value: unknown, secret: boolean): unknown => {
  if (Array.isArray(value)) return value.map((child) => redactNode(child, secret));
  if (isRecord(value)) return redactRecord(value, { valuesSecret: false, holderSecret: secret });
  return redactLeaf(value, secret);
};

export const redactSecrets = (value: unknown): unknown => redactNode(value, false);

/**
 * `incoming` with each placeholder a client sent back unchanged replaced by
 * the stored value at the same place, so saving a form never writes the
 * placeholder over a secret. `unresolved` gets the path of any text whose
 * placeholder no longer matches what is stored there (its other text was
 * edited around it), which the caller refuses rather than guess.
 */
export const restoreSecrets = (
  incoming: unknown,
  current: unknown,
  unresolved: Array<string>,
): unknown => restoreNode(incoming, current, false, "", unresolved);

const restoreNode = (
  incoming: unknown,
  current: unknown,
  secret: boolean,
  path: string,
  unresolved: Array<string>,
): unknown => {
  if (Array.isArray(incoming)) {
    return incoming.map((child, index) =>
      restoreNode(
        child,
        Array.isArray(current) ? current[index] : undefined,
        secret,
        `${path}[${index}]`,
        unresolved,
      ),
    );
  }
  if (isRecord(incoming)) {
    return restoreRecord(
      incoming,
      current,
      { valuesSecret: false, holderSecret: secret },
      path,
      unresolved,
    );
  }
  if (typeof incoming !== "string" || !incoming.includes(REDACTED)) return incoming;
  if (incoming === REDACTED || redactLeaf(current, secret) === incoming) return current;
  unresolved.push(path || "(root)");
  return incoming;
};

const restoreRecord = (
  incoming: Record<string, unknown>,
  current: unknown,
  context: { readonly valuesSecret: boolean; readonly holderSecret: boolean },
  path: string,
  unresolved: Array<string>,
): Record<string, unknown> => {
  const base = isRecord(current) ? current : {};
  return Object.fromEntries(
    Object.entries(incoming).map(([key, child]): [string, unknown] => {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (isRecord(child) && isHeaderMap(key)) {
        return [
          key,
          restoreRecord(
            child,
            base[key],
            { valuesSecret: true, holderSecret: false },
            childPath,
            unresolved,
          ),
        ];
      }
      return [
        key,
        restoreNode(child, base[key], fieldIsSecret(incoming, key, context), childPath, unresolved),
      ];
    }),
  );
};
