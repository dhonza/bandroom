import type { EditOp, EditOptions } from "@bandroom/shared";
import { notifications } from "@mantine/notifications";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useOptionalUser } from "../auth/session";
import { useTimelineUi } from "../markers/store";
import { positionSec } from "../rehearse/controller";
import type { EditTarget } from "./model";
import { runOp, useEdit } from "./store";

/** What the toolbar's ops act on right now (SPEC §24.6). */
export function editTarget(userId: string): EditTarget | null {
  const s = useEdit.getState();
  if (!s.state) return null;
  return {
    state: s.state,
    tracks: s.selectedTracks,
    selection: useTimelineUi.getState().selection,
    playheadSec: positionSec(),
    options: s.options,
    userId,
  };
}

/**
 * Runs an op built from the current options (and the toolbar's target); a refusal of the model
 * shows its short reason (SPEC §24.3: refused ops are never stored). True when it ran.
 */
export function useRunOp() {
  const { t } = useTranslation();
  const userId = useOptionalUser()?.id ?? "";
  return useCallback(
    (build: (ctx: { options: EditOptions; userId: string }) => EditOp | null): boolean => {
      const op = build({ options: useEdit.getState().options, userId });
      if (!op) return false;
      const refusal = runOp(op);
      if (refusal) {
        notifications.show({
          id: "edit-refusal",
          color: "yellow",
          message: t(`edit.refusals.${refusal}`),
        });
      }
      return refusal === null;
    },
    [t, userId],
  );
}
