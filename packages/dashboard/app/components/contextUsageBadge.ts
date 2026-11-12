import type { TFunction } from "i18next";
import type { TaskContextUsageSnapshot } from "@fusion/core";

/*
FNXC:BoardContextUsage 2026-11-12-10:59:
Presentation-only helpers for the board task-card context-usage chip. Single
source of truth for (a) the compact label (`ctx 21%`, or `ctx 214k` when the
model window is unknown), (b) the explanatory tooltip (raw tokens + window +
liveness semantics), and (c) the tone level used by TaskCard.css. Deliberately
free of React/engine imports (only TYPE imports from `@fusion/core`) so it
stays trivially unit-testable, mirroring plannerOverseerBadge.ts.

Truthfulness contract: the chip renders only when the engine attached a live
snapshot; an absent field means "session idle or usage unknown" and must render
nothing, never a stale value.
*/

/** Compact human token count: 1.2M / 214k / 940, matching the chip's mono style. */
export function formatContextTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : Math.round(millions * 10) / 10}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return `${Math.round(tokens)}`;
}

/** Tone level for the chip color; thresholds mirror common capacity-warning conventions. */
export function contextUsageLevel(snapshot: TaskContextUsageSnapshot): "normal" | "warning" {
  return (snapshot.percent ?? 0) >= 80 ? "warning" : "normal";
}

/** Compact chip label: percent of window when known, raw tokens otherwise. */
export function contextUsageBadgeLabel(
  snapshot: TaskContextUsageSnapshot,
  t?: TFunction<"app">,
): string {
  const translate: (key: string, fallback: string, opts?: Record<string, unknown>) => string =
    t ?? ((_key, fallback) => fallback);
  if (typeof snapshot.percent === "number") {
    return translate("tasks.contextUsage.badge", "ctx {{percent}}%", { percent: snapshot.percent });
  }
  return translate("tasks.contextUsage.badgeTokens", "ctx {{tokens}}", {
    tokens: formatContextTokenCount(snapshot.tokens),
  });
}

/**
 * Tooltip: leads with the raw occupancy ("AI context: 214k of 1M tokens"),
 * adds the percent when known, and closes with the liveness semantics so an
 * operator knows the value is a live board-fetch reading, not billing totals.
 */
export function contextUsageBadgeTooltip(
  snapshot: TaskContextUsageSnapshot,
  t?: TFunction<"app">,
): string {
  const translate: (
    key: string,
    fallback: string,
    opts?: Record<string, unknown>,
  ) => string =
    t ??
    ((_key, fallback, opts) => {
      if (!opts) return fallback;
      return Object.entries(opts).reduce(
        (acc, [key, value]) => acc.replaceAll(`{{${key}}}`, String(value)),
        fallback,
      );
    });

  const occupancy = typeof snapshot.contextWindow === "number"
    ? translate("tasks.contextUsage.tooltipWindow", "{{tokens}} of {{window}} tokens", {
        tokens: formatContextTokenCount(snapshot.tokens),
        window: formatContextTokenCount(snapshot.contextWindow),
      })
    : translate("tasks.contextUsage.tooltipTokens", "{{tokens}} tokens", {
        tokens: formatContextTokenCount(snapshot.tokens),
      });
  const percentSuffix = typeof snapshot.percent === "number"
    ? translate("tasks.contextUsage.tooltipPercent", " ({{percent}}%)", { percent: snapshot.percent })
    : "";
  const liveness = translate(
    "tasks.contextUsage.tooltipLiveness",
    "Live AI context for this task's active session; hidden while the session is idle. Distinct from billed token totals.",
  );
  return `${occupancy}${percentSuffix}. ${liveness}`;
}
