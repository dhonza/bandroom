import type { EditSession } from "@bandroom/shared";
import { describe, expect, it } from "vitest";
import {
  applyResult,
  editSyncAction,
  endingOf,
  noteEditChanged,
  rememberApplying,
  resultOf,
  type LocalEdit,
} from "./editSync";

const base = { tracks: [], foldedOps: 0 } as unknown as EditSession["base"];

function session(patch: Partial<EditSession> = {}): EditSession {
  return {
    id: "s1",
    songId: "song",
    status: "open",
    owner: { id: "me", name: "Me" },
    since: 1,
    updatedAt: 1,
    base,
    ops: [],
    cursor: 0,
    rev: 3,
    ...patch,
  };
}

const local = (patch: Partial<LocalEdit> = {}): LocalEdit => ({
  id: "s1",
  rev: 3,
  busy: false,
  phase: "editing",
  ...patch,
});

describe("editSyncAction", () => {
  it("enters edit mode with the owner's session, read-only while it applies", () => {
    expect(editSyncAction(session(), "me", null, null)).toEqual({ kind: "load", phase: "editing" });
    expect(editSyncAction(session({ status: "applying" }), "me", null, null)).toEqual({
      kind: "load",
      phase: "applying",
    });
    expect(editSyncAction(session({ id: "s2" }), "me", local(), null).kind).toBe("load");
    // Others' sessions and summaries without the editing state do nothing here.
    expect(editSyncAction(session({ base: undefined }), "me", null, null).kind).toBe("none");
    expect(editSyncAction(session(), "other", null, null).kind).toBe("none");
  });

  it("reloads a newer saved state only when nothing local is pending", () => {
    expect(editSyncAction(session({ rev: 4 }), "me", local(), null).kind).toBe("load");
    expect(editSyncAction(session({ rev: 4 }), "me", local({ busy: true }), null).kind).toBe(
      "none",
    );
    expect(editSyncAction(session(), "me", local(), null).kind).toBe("none");
  });

  it("turns read-only when Apply/Bounce starts and back when it fails", () => {
    const applying = session({ status: "applying" });
    expect(editSyncAction(applying, "me", local(), null).kind).toBe("applying");
    expect(editSyncAction(applying, "me", local({ phase: "applying" }), null).kind).toBe("none");
    expect(
      editSyncAction(session({ error: "boom" }), "me", local({ phase: "applying" }), null),
    ).toEqual({ kind: "failed", error: "boom" });
    // Open again without an error: a "Keep editing" bounce committed.
    expect(editSyncAction(session(), "me", local({ phase: "applying" }), null).kind).toBe(
      "committedKeep",
    );
  });

  it("leaves edit mode when the session ends, saying how", () => {
    const applying = local({ phase: "applying" });
    expect(editSyncAction(null, "me", applying, "done").kind).toBe("finished");
    expect(editSyncAction(null, "me", applying, "cancelled").kind).toBe("cancelled");
    expect(editSyncAction(null, "me", applying, null).kind).toBe("ended");
    expect(editSyncAction(null, "me", local(), "done").kind).toBe("ended");
    expect(editSyncAction(session({ status: "done" }), "me", local(), null).kind).toBe("ended");
    expect(
      editSyncAction(session({ owner: { id: "jana", name: "Jana" } }), "me", local(), null),
    ).toEqual({ kind: "takenOver", name: "Jana" });
    expect(editSyncAction(null, "me", null, "done").kind).toBe("none");
  });
});

describe("results and endings", () => {
  const render = (trackId: string, rangeId: string | null, status = "queued" as const) => ({
    trackId,
    rangeId,
    status,
  });

  it("counts tracks, or songs for a split", () => {
    expect(applyResult("apply", [render("a", null), render("b", null)], false)).toEqual({
      kind: "apply",
      count: 2,
      keepEditing: false,
    });
    const split = [render("a", "r1"), render("b", "r1"), render("a", "r2"), render("b", "r2")];
    expect(applyResult("bounceSongs", split, true).count).toBe(2);
    expect(
      applyResult(
        "bounceTracks",
        [render("a", null), { ...render("b", null), status: "skipped" }],
        false,
      ).count,
    ).toBe(1);
  });

  it("remembers what edit.changed said and what an Apply makes", () => {
    expect(endingOf("x1")).toBeNull();
    noteEditChanged({ sessionId: "x1", status: "open" });
    expect(endingOf("x1")).toBeNull();
    noteEditChanged({ sessionId: "x1", status: "done" });
    expect(endingOf("x1")).toBe("done");
    noteEditChanged({ status: "done" });

    rememberApplying(session({ id: "x2" }));
    expect(resultOf("x2")).toBeNull();
    rememberApplying(
      session({
        id: "x2",
        status: "applying",
        outcome: { kind: "bounceVersions", by: "me", at: 1, keepEditing: false },
        renders: [
          {
            id: "r",
            trackId: "a",
            rangeId: null,
            status: "running",
            phase: "render",
            progress: 0.5,
            peakDb: null,
            error: null,
          },
        ],
      }),
    );
    expect(resultOf("x2")).toEqual({ kind: "bounceVersions", count: 1, keepEditing: false });
  });
});
