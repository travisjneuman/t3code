/**
 * "Other Agents" group in the command palette: the same session search the
 * sidebar runs, listed after T3's own results. The server already matched the
 * query, so the palette appends the group after its own filtering. Fork add-on.
 */
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import type { CommandPaletteGroup } from "../components/CommandPalette.logic";
import { formatProviderDriverKindLabel } from "../providerModels";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { useSessionSearch } from "./atoms";

function folderName(cwd: string | null): string | null {
  if (cwd === null) return null;
  return (
    cwd
      .split(/[\\/]+/)
      .filter((segment) => segment.length > 0)
      .at(-1) ?? cwd
  );
}

/** Null until a search returns sessions. */
export function useSessionSearchPaletteGroup(query: string): CommandPaletteGroup | null {
  const search = useSessionSearch(query);
  const navigate = useNavigate();
  return useMemo(() => {
    if (search.entries.length === 0) return null;
    const trimmed = query.trim();
    return {
      value: "other-agents-search",
      label: search.complete ? "Other Agents" : "Other Agents (partial)",
      items: search.entries.map(({ environmentId, environmentLabel, hit }) => {
        const title = hit.title.trim().length > 0 ? hit.title.trim() : "Untitled session";
        const product =
          PROVIDER_DISPLAY_NAMES[hit.driver] ?? formatProviderDriverKindLabel(hit.driver);
        const { snippet } = hit;
        return {
          kind: "action" as const,
          value: `external-session:${environmentId}:${hit.key}`,
          searchTerms: [trimmed, title],
          title,
          description: [product, folderName(hit.cwd), environmentLabel]
            .filter((part): part is string => part !== null && part.length > 0)
            .join(" · "),
          ...(snippet.source === "title"
            ? {}
            : {
                threadContentMatch: {
                  source: snippet.source,
                  snippet: snippet.text,
                  query: trimmed,
                },
              }),
          timestamp: formatRelativeTimeLabel(hit.updatedAt),
          icon: (
            <ProviderInstanceIcon
              driverKind={hit.driver}
              displayName={product}
              className="size-4 shrink-0"
              iconClassName="size-4"
            />
          ),
          run: async () => {
            await navigate({
              to: "/external/$environmentId/$sessionKey",
              params: { environmentId, sessionKey: hit.key },
            });
          },
        };
      }),
    };
  }, [navigate, query, search.complete, search.entries]);
}
