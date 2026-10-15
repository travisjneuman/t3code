/**
 * Fork add-on: Hermes Codex lists the account's live models. Hermes's Codex
 * group gains the models T3's signed-in Codex provider lists for the same
 * ChatGPT account (see `withAccountCodexModels`). Applied wherever the
 * registry merges snapshots, so either provider's refresh updates the group.
 *
 * @module hermesAccountCodexModels
 */
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { withAccountCodexModels } from "@t3tools/provider-hermes/server";

const CODEX = ProviderDriverKind.make("codex");
const HERMES = ProviderDriverKind.make("hermes");

export const withHermesAccountCodexModels = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> => {
  const codexModels = providers
    .filter(
      (provider) =>
        provider.driver === CODEX &&
        provider.enabled &&
        provider.status === "ready" &&
        provider.auth.status === "authenticated",
    )
    .flatMap((provider) => provider.models);
  if (codexModels.length === 0) return providers;
  return providers.map((provider) =>
    provider.driver === HERMES
      ? { ...provider, models: withAccountCodexModels(provider.models, codexModels) }
      : provider,
  );
};
