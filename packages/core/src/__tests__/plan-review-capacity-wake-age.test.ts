import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN_REVIEW_CAPACITY_WAKE_AGE_MS,
  resolvePlanReviewCapacityWakeAgeMs,
} from "../workflows/workflow-capacity.js";

/*
FNXC:PlanReviewCapacityWake 2026-11-06-06:07:
Unit coverage for the poll-boundary age-priority resolver (KB-009 / SUBC-016).

Contract under test:
- undefined → shipped default (30 minutes) — the live settings blob is authoritative
  but a missing key must never disable or over-tighten the priority.
- a configured ZERO is HONORED (0ms = no age gate): zero is a legible operator
  statement ("suspended rows are priority-admitted immediately"), not a missing value.
- negative / non-finite / non-numeric values fall back to the default rather than
  producing NaN millisecond comparisons in the wake selector.
*/

describe("resolvePlanReviewCapacityWakeAgeMs", () => {
  it("defaults to 30 minutes when the setting is undefined", () => {
    expect(resolvePlanReviewCapacityWakeAgeMs(undefined)).toBe(DEFAULT_PLAN_REVIEW_CAPACITY_WAKE_AGE_MS);
    expect(resolvePlanReviewCapacityWakeAgeMs(null)).toBe(DEFAULT_PLAN_REVIEW_CAPACITY_WAKE_AGE_MS);
    expect(resolvePlanReviewCapacityWakeAgeMs({})).toBe(DEFAULT_PLAN_REVIEW_CAPACITY_WAKE_AGE_MS);
    expect(resolvePlanReviewCapacityWakeAgeMs({ planReviewCapacityWakeAgeMinutes: undefined })).toBe(
      DEFAULT_PLAN_REVIEW_CAPACITY_WAKE_AGE_MS,
    );
    expect(DEFAULT_PLAN_REVIEW_CAPACITY_WAKE_AGE_MS).toBe(30 * 60_000);
  });

  it("honors a configured zero as no age gate", () => {
    expect(resolvePlanReviewCapacityWakeAgeMs({ planReviewCapacityWakeAgeMinutes: 0 })).toBe(0);
  });

  it("converts a configured value in minutes to milliseconds", () => {
    expect(resolvePlanReviewCapacityWakeAgeMs({ planReviewCapacityWakeAgeMinutes: 5 })).toBe(5 * 60_000);
    expect(resolvePlanReviewCapacityWakeAgeMs({ planReviewCapacityWakeAgeMinutes: 90 })).toBe(90 * 60_000);
  });

  it("falls back to the default for invalid values", () => {
    expect(resolvePlanReviewCapacityWakeAgeMs({ planReviewCapacityWakeAgeMinutes: -1 })).toBe(
      DEFAULT_PLAN_REVIEW_CAPACITY_WAKE_AGE_MS,
    );
    expect(resolvePlanReviewCapacityWakeAgeMs({ planReviewCapacityWakeAgeMinutes: Number.NaN })).toBe(
      DEFAULT_PLAN_REVIEW_CAPACITY_WAKE_AGE_MS,
    );
    expect(
      resolvePlanReviewCapacityWakeAgeMs({ planReviewCapacityWakeAgeMinutes: Number.POSITIVE_INFINITY }),
    ).toBe(DEFAULT_PLAN_REVIEW_CAPACITY_WAKE_AGE_MS);
    expect(resolvePlanReviewCapacityWakeAgeMs({ planReviewCapacityWakeAgeMinutes: "30" as unknown as number })).toBe(
      DEFAULT_PLAN_REVIEW_CAPACITY_WAKE_AGE_MS,
    );
  });
});
