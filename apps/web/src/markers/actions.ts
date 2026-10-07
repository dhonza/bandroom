import type { Song } from "@bandroom/shared";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { MIN_SELECTION_SEC } from "./model";
import { useMarkerActions } from "./queries";
import { anchorNow, openEditor, positionNow, useTimelineUi } from "./store";

/** "+ Marker" / `M`: a marker at the playhead, named "Marker N" (rename later). */
export function useAddMarker(song: Song) {
  const { t } = useTranslation();
  const { create } = useMarkerActions(song.id);
  return useCallback(
    (at?: number) => {
      const markers = useTimelineUi.getState().markers;
      const n = markers.filter((m) => m.type === "marker").length + 1;
      void create({
        type: "marker",
        name: t("markers.defaultMarkerName", { n }),
        color: "yellow",
        startSec: Math.max(0, at ?? positionNow()),
        anchor: anchorNow(),
      });
    },
    [create, t],
  );
}

/** "+ Section" / `Shift+M`: opens the editor for a section from the selection. */
export function addSectionFromSelection(): boolean {
  const s = useTimelineUi.getState();
  if (!s.selection || s.selection.end - s.selection.start < MIN_SELECTION_SEC) return false;
  openEditor({ mode: "create", type: "section", range: s.selection });
  return true;
}
