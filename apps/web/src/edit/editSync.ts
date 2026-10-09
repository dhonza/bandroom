import type { EditOutcomeKind, EditRenderProgress, EditSession } from "@bandroom/shared";
import type { EditPhase } from "./store";

/**
 * How the page follows the server's session (SPEC §24.7, §24.8), as a pure decision: enter or
 * reload the edit, turn read-only while Apply/Bounce renders, go back to editing when it failed
 * (or a "Keep editing" bounce committed), or leave edit mode (taken over, ended, finished).
 */

export interface LocalEdit {
  id: string;
  rev: number;
  /** Unsent changes or a save in flight. */
  busy: boolean;
  phase: EditPhase;
}

export type EditSyncAction =
  /** Nothing to do. */
  | { kind: "none" }
  /** Enter edit mode with the server's state (start, reload, another tab). */
  | { kind: "load"; phase: EditPhase }
  /** Apply/Bounce started (here or in another tab): read-only. */
  | { kind: "applying" }
  /** Apply/Bounce failed: editable again, the failure is shown. */
  | { kind: "failed"; error: string }
  /** A "Keep editing" bounce committed: editable again with the new state. */
  | { kind: "committedKeep" }
  /** The session ended after Apply/Bounce (committed), or by cancel elsewhere. */
  | { kind: "finished" }
  | { kind: "cancelled" }
  | { kind: "takenOver"; name: string }
  | { kind: "ended" };

/** The final status of a session as `edit.changed` announced it (null: not seen). */
export type Ending = "done" | "cancelled" | "failed" | null;

export function editSyncAction(
  server: EditSession | null,
  me: string | null,
  local: LocalEdit | null,
  ending: Ending,
): EditSyncAction {
  const active = server && (server.status === "open" || server.status === "applying");
  if (server && active && server.owner.id === me && server.base) {
    const phase: EditPhase = server.status === "applying" ? "applying" : "editing";
    if (!local || local.id !== server.id) return { kind: "load", phase };
    if (phase === "applying")
      return local.phase === "applying" ? { kind: "none" } : { kind: "applying" };
    if (local.phase === "applying") {
      if (server.error) return { kind: "failed", error: server.error };
      return { kind: "committedKeep" };
    }
    if ((server.rev ?? 0) > local.rev && !local.busy) return { kind: "load", phase };
    return { kind: "none" };
  }
  if (!local) return { kind: "none" };
  if (server && active && server.owner.id !== me)
    return { kind: "takenOver", name: server.owner.name };
  if (local.phase === "applying") {
    if (ending === "cancelled") return { kind: "cancelled" };
    if (ending === "done") return { kind: "finished" };
  }
  return { kind: "ended" };
}

/** What a finished Apply/Bounce made, for the toast (SPEC §24.8/§24.9). */
export interface ApplyResult {
  kind: EditOutcomeKind;
  /** Tracks applied / versions / tracks / songs created. */
  count: number;
  keepEditing: boolean;
}

/** Counts the results of an Apply/Bounce from its renders (one per output track). */
export function applyResult(
  kind: EditOutcomeKind,
  renders: readonly Pick<EditRenderProgress, "trackId" | "rangeId" | "status">[],
  keepEditing: boolean,
): ApplyResult {
  const live = renders.filter((r) => r.status !== "skipped");
  const count =
    kind === "bounceSongs"
      ? new Set(live.map((r) => r.rangeId ?? "")).size
      : new Set(live.map((r) => r.trackId)).size;
  return { kind, count, keepEditing };
}

// ——— What `edit.changed` said, and what a running Apply/Bounce makes ————————————————————————

const endings = new Map<string, Ending>();
const results = new Map<string, ApplyResult>();

/** Remembers how a session ended (`edit.changed` carries its status). */
export function noteEditChanged(data: Record<string, unknown>): void {
  const id = typeof data.sessionId === "string" ? data.sessionId : null;
  const status = data.status;
  if (!id) return;
  if (status === "done" || status === "cancelled" || status === "failed") endings.set(id, status);
}

export function endingOf(sessionId: string): Ending {
  return endings.get(sessionId) ?? null;
}

/** Keeps what a running Apply/Bounce makes (the session is gone after the commit). */
export function rememberApplying(session: EditSession): void {
  if (!session.outcome || !session.renders?.length) return;
  results.set(
    session.id,
    applyResult(session.outcome.kind, session.renders, session.outcome.keepEditing),
  );
}

export function resultOf(sessionId: string): ApplyResult | null {
  return results.get(sessionId) ?? null;
}
