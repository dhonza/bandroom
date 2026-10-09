import { notifications } from "@mantine/notifications";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useTimelineUi } from "../markers/store";
import {
  rangeFrames,
  rangeOp,
  splitAtMarkersOp,
  splitOp,
  unavailable,
  type RangeAction,
  type UnavailableReason,
} from "./model";
import { openEditDialog, redoEdit, undoEdit, useEdit } from "./store";
import { editTarget, useRunOp } from "./useRunOp";

/** The toolbar's and the shortcuts' edit actions (SPEC §24.6). */
export function useEditActions() {
  const { t } = useTranslation();
  const runOp = useRunOp();
  return useMemo(() => {
    const explain = (reason: UnavailableReason) => {
      notifications.show({
        id: "edit-refusal",
        color: "yellow",
        message: t(`edit.reasons.${reason}`),
      });
    };
    const withTarget = (action: "split" | RangeAction, run: () => boolean): boolean => {
      const target = editTarget("");
      if (!target) return false;
      const reason = unavailable(action, target);
      if (reason) {
        explain(reason);
        return false;
      }
      return run();
    };
    return {
      split: () =>
        withTarget("split", () =>
          runOp((o) => {
            const target = editTarget(o.userId);
            return target && splitOp(target);
          }),
        ),
      range: (action: Exclude<RangeAction, "gain">) =>
        withTarget(action, () =>
          runOp((o) => {
            const target = editTarget(o.userId);
            return target && rangeOp(target, action);
          }),
        ),
      gain: (gainDb: number) =>
        withTarget("gain", () =>
          runOp((o) => {
            const target = editTarget(o.userId);
            return target && rangeOp(target, "gain", gainDb);
          }),
        ),
      /** Opens the gain dialog (`G`), or says why not. */
      openGain: () => {
        const target = editTarget("");
        if (!target) return;
        const reason = unavailable("gain", target);
        if (reason) explain(reason);
        else openEditDialog("gain");
      },
      splitAtMarkers: (points: readonly { id: string; sec: number }[]) =>
        runOp((o) => {
          const target = editTarget(o.userId);
          return target && splitAtMarkersOp(target, points);
        }),
      undo: () => undoEdit(),
      redo: () => redoEdit(),
    };
  }, [runOp, t]);
}

/** Why each toolbar action is unavailable now (null: available), for the disabled buttons. */
export function useEditAvailability(): Record<"split" | RangeAction, UnavailableReason | null> {
  const selection = useTimelineUi((s) => s.selection);
  const state = useEdit((s) => s.state);
  const tracks = useEdit((s) => s.selectedTracks);
  return useMemo(() => {
    if (!state)
      return { split: "noTracks", cut: "noTracks", silence: "noTracks", gain: "noTracks" };
    const noTracks = tracks.length === 0 ? ("noTracks" as const) : null;
    const range = rangeFrames({ selection, state }) ? null : ("noRange" as const);
    return {
      split: noTracks,
      cut: noTracks ?? range,
      silence: noTracks ?? range,
      gain: noTracks ?? range,
    };
  }, [selection, state, tracks]);
}
