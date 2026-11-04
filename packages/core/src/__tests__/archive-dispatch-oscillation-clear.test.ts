/**
 * FNXC:SchedulerDispatchOscillation 2026-11-04-10:09 (FIX-10):
 * Unit contract for `softDeleteTaskRowInTransaction`'s `clearDispatchOscillation` option:
 * the archive transition's soft-delete UPDATE must null the persisted requeue-loop columns
 * in the SAME statement as the deletion (a follow-up write against the soft-deleted row is
 * refused by the store), and callers that do not opt in keep the exact previous patch.
 */
import { describe, expect, it, vi } from "vitest";
import type { DbTransaction } from "../postgres/data-layer.js";

import { softDeleteTaskRowInTransaction } from "../task-store/async/async-persistence.js";

function createFakeTx(claimedIds: string[]) {
  const set = vi.fn().mockReturnThis();
  const where = vi.fn().mockReturnThis();
  const returning = vi.fn().mockResolvedValue(claimedIds.map((id) => ({ id })));
  const update = vi.fn().mockReturnValue({ set, where, returning });
  return { tx: { update } as unknown as DbTransaction, update, set, where, returning };
}

describe("softDeleteTaskRowInTransaction clearDispatchOscillation option", () => {
  it("nulls the persisted oscillation columns in the same UPDATE when the archive opts in", async () => {
    const { tx, set } = createFakeTx(["SUBC-007"]);

    const claimed = await softDeleteTaskRowInTransaction(
      tx,
      "SUBC-007",
      "2026-11-03T16:21:15.823Z",
      false,
      "proj-1",
      false,
      { clearDispatchOscillation: true },
    );

    expect(claimed).toBe(true);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      column: "archived",
      deletedAt: "2026-11-03T16:21:15.823Z",
      executeRequeueLoopCount: null,
      executeRequeueLoopSignature: null,
    }));
  });

  it("keeps the previous patch exactly when no option is passed (plain delete path)", async () => {
    const { tx, set } = createFakeTx(["SUBC-007"]);

    await softDeleteTaskRowInTransaction(tx, "SUBC-007", "2026-11-03T16:21:15.823Z", true, "proj-1", true);

    const patch = set.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).toEqual({
      column: "archived",
      deletedAt: "2026-11-03T16:21:15.823Z",
      allowResurrection: 1,
      updatedAt: "2026-11-03T16:21:15.823Z",
    });
    expect(patch).not.toHaveProperty("executeRequeueLoopCount");
    expect(patch).not.toHaveProperty("executeRequeueLoopSignature");
  });

  it("reports an unclaimed soft-delete when the returning set is empty", async () => {
    const { tx, returning } = createFakeTx([]);

    const claimed = await softDeleteTaskRowInTransaction(
      tx,
      "SUBC-007",
      "2026-11-03T16:21:15.823Z",
      false,
      "proj-1",
      false,
      { clearDispatchOscillation: true },
    );

    expect(claimed).toBe(false);
    expect(returning).toHaveBeenCalledTimes(1);
  });
});
