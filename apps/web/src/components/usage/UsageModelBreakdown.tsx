/**
 * Usage → Breakdown → Model: one ranked row per real model, with a sub-line
 * for each route when it ran through more than one, and a footer for usage no
 * model can claim. The model dialog's route table lives here too.
 * Fork add-on: one usage row per model.
 */
import type { UsageProviderKind } from "@t3tools/contracts";
import { formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { isModelCostUnknown, type ModelTotals } from "@t3tools/shared/usageMerge";
import type { UsageModelRoute, UsageModelRow } from "@t3tools/shared/usageModelGroups";
import { Fragment } from "react";

import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cacheHitRate, costPerMillionTokens, modelShare } from "./usageBreakdown";
import {
  usageModelRow,
  usageModelSoleRouteNeedsLabel,
  usageModelTitle,
  usageRouteColors,
  usageRouteLabel,
  usageRouteNote,
} from "./usageModelRows";
import { PROVIDER_PRESENTATION } from "./usageProviders";

type Metric = "cost" | "tokens";

const metricValue = (totals: ModelTotals, metric: Metric) =>
  metric === "tokens" ? totals.totalTokens : totals.costUsd;

/** Routes in the order the selected metric ranks them, so the bar and the sub-lines agree. */
function sortedRoutes(row: UsageModelRow, metric: Metric) {
  const routes = row.grouping.routes.toSorted(
    (left, right) =>
      metricValue(right, metric) - metricValue(left, metric) ||
      right.totalTokens - left.totalTokens,
  );
  const colors = usageRouteColors(routes);
  return routes.map((route, index) => ({ route, color: colors[index]! }));
}

function figureClass(loading: boolean) {
  return cn("transition-opacity", loading && "opacity-40 delay-150");
}

const routeKey = (route: UsageModelRoute) =>
  JSON.stringify([route.provider, route.routeSlug, route.tier]);

function RouteLabel({
  route,
  className,
}: {
  readonly route: UsageModelRoute;
  readonly className?: string;
}) {
  const label = usageRouteLabel(route);
  const note = usageRouteNote(route);
  if (note === null) return <span className={className}>{label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn("underline decoration-dotted underline-offset-2", className)} />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup>{note}</TooltipPopup>
    </Tooltip>
  );
}

function UsageModelRows({
  row,
  rank,
  metric,
  peak,
  loadingProviders,
  onSelectModel,
}: {
  readonly row: UsageModelRow;
  readonly rank: number | null;
  readonly metric: Metric;
  readonly peak: number;
  readonly loadingProviders: ReadonlySet<UsageProviderKind>;
  readonly onSelectModel: (key: string) => void;
}) {
  const routes = sortedRoutes(row, metric);
  const value = metricValue(row, metric);
  const hasBar = rank !== null && value > 0 && peak > 0;
  const share = modelShare(row, metric);
  const rowFigures = figureClass(
    row.grouping.routes.some((route) => loadingProviders.has(route.provider)),
  );
  const showSubLines = routes.length > 1;
  const soleRoute = usageModelSoleRouteNeedsLabel(row) ? routes[0]?.route : undefined;
  const presentation = PROVIDER_PRESENTATION[row.provider];
  return (
    <>
      <tr
        className={cn(
          "relative text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/50 has-focus-visible:bg-muted/50",
          !showSubLines && "border-b border-border/50",
        )}
      >
        <td className="py-2.5 pr-3 text-left text-xs">{rank ?? ""}</td>
        <td className="py-2.5 text-left whitespace-normal">
          <button
            type="button"
            onClick={() => onSelectModel(row.grouping.key)}
            className={cn(
              "flex items-center gap-2 text-left text-foreground outline-none after:absolute after:inset-0",
              !hasBar && "py-1",
            )}
          >
            <ProviderInstanceIcon
              driverKind={presentation.driverKind}
              displayName={presentation.label}
              iconClassName="size-3.5"
            />
            {usageModelTitle(row)}
            {soleRoute === undefined ? null : (
              <span className="text-xs text-muted-foreground">
                via <RouteLabel route={soleRoute} className="relative z-10" />
              </span>
            )}
          </button>
          {hasBar ? (
            <div aria-hidden className={cn("mt-1.5 h-0.5 max-w-48", rowFigures)}>
              <div
                className="flex h-full gap-px overflow-hidden rounded-full"
                style={{ width: `max(0.5rem, ${(value / peak) * 100}%)` }}
              >
                {routes
                  .filter(({ route }) => metricValue(route, metric) > 0)
                  .map(({ route, color }) => (
                    <div
                      key={routeKey(route)}
                      className="h-full"
                      style={{ flex: `${metricValue(route, metric)} 1 0`, backgroundColor: color }}
                    />
                  ))}
              </div>
            </div>
          ) : null}
        </td>
        <td className={cn("py-2.5 pl-6 text-foreground", rowFigures)}>
          {isModelCostUnknown(row) ? (
            <span className="text-muted-foreground">Unpriced</span>
          ) : (
            formatUsd(row.costUsd)
          )}
        </td>
        <td className={cn("hidden py-2.5 pl-6 sm:table-cell", rowFigures)}>
          {share === null ? "" : formatPercent(share)}
        </td>
        <td className={cn("py-2.5 pl-6", rowFigures)}>{formatTokens(row.totalTokens)}</td>
      </tr>
      {showSubLines
        ? routes.map(({ route, color }, index) => {
            const last = index === routes.length - 1;
            return (
              <tr
                key={routeKey(route)}
                className={cn(
                  "text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums",
                  last && "border-b border-border/50",
                )}
              >
                <td />
                <td className={cn("pt-0.5 pl-5.5 text-left whitespace-normal", last && "pb-2.5")}>
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <RouteLabel route={route} />
                  </span>
                </td>
                <td className={cn("pt-0.5 pl-6", last && "pb-2.5", rowFigures)}>
                  {isModelCostUnknown(route) ? "Unpriced" : formatUsd(route.costUsd)}
                </td>
                <td className="hidden sm:table-cell" />
                <td className={cn("pt-0.5 pl-6", last && "pb-2.5", rowFigures)}>
                  {formatTokens(route.totalTokens)}
                </td>
              </tr>
            );
          })
        : null}
    </>
  );
}

export function UsageModelBreakdownBody({
  models,
  metric,
  loadingProviders,
  onSelectModel,
}: {
  readonly models: readonly ModelTotals[];
  readonly metric: Metric;
  readonly loadingProviders: ReadonlySet<UsageProviderKind>;
  readonly onSelectModel: (key: string) => void;
}) {
  const rows = models.map(usageModelRow);
  const ranked = rows.filter((row) => row.grouping.unattributed === null);
  const unattributed = rows.filter((row) => row.grouping.unattributed !== null);
  const peak = ranked.reduce((max, row) => Math.max(max, metricValue(row, metric)), 0);
  const rowProps = { metric, peak, loadingProviders, onSelectModel };

  if (rows.length === 0) {
    return (
      <tbody>
        <tr>
          <td colSpan={5} className="py-6 text-center text-muted-foreground">
            No activity in this window.
          </td>
        </tr>
      </tbody>
    );
  }
  return (
    <tbody>
      {ranked.map((row, index) => (
        <UsageModelRows key={row.grouping.key} row={row} rank={index + 1} {...rowProps} />
      ))}
      {unattributed.length === 0 ? null : (
        <Fragment>
          <tr>
            <td colSpan={5} className="pt-5 pb-1 text-left text-xs text-muted-foreground">
              Not tied to a model
            </td>
          </tr>
          {unattributed.map((row) => (
            <UsageModelRows key={row.grouping.key} row={row} rank={null} {...rowProps} />
          ))}
        </Fragment>
      )}
    </tbody>
  );
}

/** Per-route figures in the model dialog, when the model ran through more than one route. */
export function UsageModelRouteTable({ model }: { readonly model: ModelTotals }) {
  const row = usageModelRow(model);
  if (row.grouping.routes.length < 2) return null;
  const routes = sortedRoutes(row, "cost");
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-right text-xs text-muted-foreground">
          <th className="w-full py-2 text-left font-normal">Route</th>
          <th className="py-2 pl-6 font-normal">Cost</th>
          <th className="py-2 pl-6 font-normal">Tokens</th>
          <th className="hidden py-2 pl-6 font-normal sm:table-cell">Per 1M</th>
          <th className="hidden py-2 pl-6 font-normal sm:table-cell">Cache hit</th>
        </tr>
      </thead>
      <tbody>
        {routes.map(({ route, color }) => {
          const perMillion = costPerMillionTokens(route);
          const hitRate = cacheHitRate(route);
          return (
            <tr
              key={routeKey(route)}
              className="border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums"
            >
              <td className="py-2 text-left whitespace-normal text-foreground">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <RouteLabel route={route} />
                </span>
              </td>
              <td className="py-2 pl-6 text-foreground">
                {isModelCostUnknown(route) ? "Unpriced" : formatUsd(route.costUsd)}
              </td>
              <td className="py-2 pl-6">{formatTokens(route.totalTokens)}</td>
              <td className="hidden py-2 pl-6 sm:table-cell">
                {perMillion === null ? "" : formatUsd(perMillion)}
              </td>
              <td className="hidden py-2 pl-6 sm:table-cell">
                {hitRate === null ? "" : formatPercent(hitRate)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
