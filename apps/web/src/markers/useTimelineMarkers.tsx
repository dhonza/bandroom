import { lockedOut, type Marker, type Song } from "@bandroom/shared";
import { useCallback, useEffect, useState } from "react";
import { useSongTempo } from "../tempo/queries";
import { useTempoUi } from "../tempo/store";
import { openTempoDialog } from "../tempo/TempoDialog";
import { useLaneVisibility } from "../timeline/laneVisibility";
import { RULER_H, type TimelineProps } from "../timeline/Timeline";
import type { View } from "../timeline/view";
import {
  bandsOf,
  guidesOf,
  markerPatch,
  MIN_SELECTION_SEC,
  orderedRange,
  sectionMatching,
  type Range,
} from "./model";
import { LanesMenu } from "./LanesMenu";
import { SIGNATURE_ITEM_PREFIX, SignatureLane } from "./SignatureLane";
import { useMarkerActions, useMarkerPermissions, useSongMarkers } from "./queries";
import { COMMENT_ITEM_PREFIX, commentLaneHeight, CommentsLane } from "../comments/CommentsLane";
import { useSongComments } from "../comments/queries";
import { openCommentsFor } from "../comments/store";
import { tapComment } from "../comments/actions";
import {
  anchorNow,
  clearSelection,
  openTimeline,
  setDragging,
  setSelection,
  useTimelineUi,
} from "./store";
import {
  makeSnapper,
  MarkersOverlay,
  tapItem,
  TopLaneLabels,
  useMarkerLayout,
} from "./TimelineMarkers";

/** The timeline's context menu at `sec`; `editId`: the editable item it was opened on. */
export interface TimelineMenuState {
  sec: number;
  x: number;
  y: number;
  editId: string | null;
}

type TimelineMarkerProps = Pick<
  TimelineProps,
  | "topLanesHeight"
  | "renderOverlay"
  | "renderTopHeader"
  | "renderCorner"
  | "bands"
  | "guides"
  | "overviewRange"
  | "zoomRange"
  | "overviewRangeColor"
  | "onSelectDrag"
  | "onLongPress"
  | "onItemTap"
  | "grid"
>;

/**
 * Wires markers, sections and the selection into a song page's timeline (SPEC §7.4–§7.6) and
 * returns the Timeline props plus the long-press menu state.
 */
export function useTimelineMarkers(
  song: Song,
  durationSec: number,
  laneCount: number,
  laneHeight: number,
) {
  const { markers } = useSongMarkers(song.id);
  useSongTempo(song.id);
  const grid = useTempoUi((s) => (s.songId === song.id ? s.grid : null));
  const { canEdit, canCreate } = useMarkerPermissions(song);
  const actions = useMarkerActions(song.id);
  const layout = useMarkerLayout(markers, grid !== null);
  // Tapping a time signature opens the tempo dialog (not while the song is locked, SPEC §25.12).
  const tempoEditable =
    song.access.capabilities.includes("tempo.edit") &&
    !lockedOut(song.locked !== null, "tempo.edit");
  const { comments } = useSongComments(song.id);
  // The comment lane shows only when the song has comments and it is not hidden (SPEC §11.3).
  const commentsHidden = useLaneVisibility((s) => s.hidden.comments);
  const commentH = comments.length > 0 && !commentsHidden ? commentLaneHeight(layout.coarse) : 0;
  // The lanes menu, once some top lane has items (shown or not).
  const hasLaneItems = grid !== null || markers.length > 0 || comments.length > 0;
  const selection = useTimelineUi((s) => s.selection);
  const loopOn = useTimelineUi((s) => s.loopOn);
  const [menu, setMenu] = useState<TimelineMenuState | null>(null);

  useEffect(() => {
    openTimeline(song.id);
    openCommentsFor(song.id);
  }, [song.id]);

  const onCommit = useCallback(
    (m: Marker, r: Range) => {
      void actions.update(m, markerPatch(m, r, anchorNow(m.anchor)));
      if (m.type === "section" && useTimelineUi.getState().picked === m.id) setSelection(r, m.id);
    },
    [actions],
  );

  // `laneCount` 0: the waveform lanes are hidden (Mixer closed, SPEC §11.3).
  const detailHeight = RULER_H + layout.height + commentH + laneCount * laneHeight;
  const props: TimelineMarkerProps = {
    grid,
    topLanesHeight: layout.height + commentH,
    renderTopHeader: () => <TopLaneLabels layout={layout} commentsHeight={commentH} />,
    ...(hasLaneItems && { renderCorner: () => <LanesMenu /> }),
    renderOverlay: (view: View) => (
      <>
        {grid && layout.signatureH > 0 && (
          <SignatureLane
            view={view}
            grid={grid}
            top={RULER_H}
            height={layout.signatureH}
            onOpen={tempoEditable ? openTempoDialog : null}
          />
        )}
        {commentH > 0 && (
          <CommentsLane
            view={view}
            comments={comments}
            top={RULER_H + layout.height}
            height={commentH}
          />
        )}
        <MarkersOverlay
          view={view}
          markers={markers}
          layout={layout}
          canEdit={canEdit}
          durationSec={durationSec}
          height={detailHeight}
          onCommit={onCommit}
        />
      </>
    ),
    bands: bandsOf(markers),
    guides: guidesOf(markers),
    overviewRange: selection,
    // While the loop is on it equals the selection (store.ts), so both are the selection.
    zoomRange: selection,
    overviewRangeColor: loopOn ? "yellow" : "blue",
    onSelectDrag: (anchorSec, sec, phase, view) => {
      const snap = makeSnapper(view, markers);
      const r = orderedRange(snap(anchorSec, false), snap(sec, false));
      if (phase === "move") {
        setDragging(true);
        setSelection(r);
        return;
      }
      setDragging(false);
      if (r.end - r.start < MIN_SELECTION_SEC) clearSelection();
      else setSelection(r, sectionMatching(markers, r)?.id ?? null);
    },
    onLongPress: (sec, x, y, item) => {
      // A marker or section under the pointer can be edited from the menu (SPEC §25.7).
      const m = item ? markers.find((x) => x.id === item) : undefined;
      setMenu({ sec, x, y, editId: m && canEdit(m) ? m.id : null });
    },
    onItemTap: (id) => {
      if (id.startsWith(SIGNATURE_ITEM_PREFIX)) {
        if (tempoEditable) openTempoDialog();
        return;
      }
      if (id.startsWith(COMMENT_ITEM_PREFIX)) {
        const c = comments.find((x) => `${COMMENT_ITEM_PREFIX}${x.id}` === id);
        if (c) tapComment(c);
        return;
      }
      const m = markers.find((x) => x.id === id);
      if (m) tapItem(m, canEdit(m));
    },
  };
  return {
    props,
    markers,
    canCreate,
    canEdit,
    actions,
    menu,
    closeMenu: () => {
      setMenu(null);
    },
  };
}
