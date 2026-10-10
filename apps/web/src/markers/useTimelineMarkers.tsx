import { type Marker, type Song } from "@bandroom/shared";
import { frozenBy } from "../features/song/songLock";
import { useCallback, useEffect, useState } from "react";
import { useSongTempo } from "../tempo/queries";
import { useTempoUi } from "../tempo/store";
import { openTempoDialog } from "../tempo/TempoDialog";
import { useLaneVisibility } from "../timeline/laneVisibility";
import type { TimelineProps } from "../timeline/Timeline";
import type { View } from "../timeline/view";
import {
  guidesOf,
  markerPatch,
  MIN_SELECTION_SEC,
  orderedRange,
  sectionMatching,
  type Range,
} from "./model";
import { RulerMeters, SIGNATURE_ITEM_PREFIX } from "./SignatureLane";
import { useMarkerActions, useMarkerPermissions, useSongMarkers } from "./queries";
import { COMMENT_ITEM_PREFIX, commentLaneHeight, CommentsLane } from "../comments/CommentsLane";
import { useSongComments } from "../comments/queries";
import { openCommentsFor } from "../comments/store";
import { tapComment } from "../comments/actions";
import { useRemappedComments, useRemappedMarkers, useTempoRemapPreview } from "../edit/preview";
import {
  anchorNow,
  clearSelection,
  openTimeline,
  setDragging,
  setMarkers,
  setSelection,
  useTimelineUi,
} from "./store";
import {
  makeSnapper,
  MarkersOverlay,
  OverviewLabel,
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
  | "guides"
  | "overviewRange"
  | "zoomRange"
  | "overviewRangeColor"
  | "onSelectDrag"
  | "onLongPress"
  | "onItemTap"
  | "grid"
  | "rulerHeight"
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
  const { markers: stored } = useSongMarkers(song.id);
  const { tempo } = useSongTempo(song.id);
  // Edit mode previews where the edit moves them (SPEC §24.4); nothing is written.
  const markers = useRemappedMarkers(song.id, stored, tempo);
  useTempoRemapPreview(song.id, tempo);
  // Navigation and loop targets follow the previewed items too (after the stored list's effect).
  useEffect(() => {
    setMarkers(markers);
  }, [markers]);
  const grid = useTempoUi((s) => (s.songId === song.id ? s.grid : null));
  const { canEdit, canCreate } = useMarkerPermissions(song);
  const actions = useMarkerActions(song.id);
  const layout = useMarkerLayout(markers);
  // Tapping a time signature opens the tempo dialog (not while the song is locked, SPEC §25.12).
  const tempoEditable =
    song.access.capabilities.includes("tempo.edit") && frozenBy(song, "tempo.edit") === null;
  const { comments: storedComments } = useSongComments(song.id);
  const comments = useRemappedComments(song.id, storedComments);
  // The comment lane shows only when the song has comments and it is not hidden (SPEC §11.3).
  const commentsHidden = useLaneVisibility((s) => s.hidden.comments);
  const commentH = comments.length > 0 && !commentsHidden ? commentLaneHeight(layout.coarse) : 0;
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
  const detailHeight = layout.rulerH + layout.height + commentH + laneCount * laneHeight;
  const props: TimelineMarkerProps = {
    grid,
    rulerHeight: layout.rulerH,
    topLanesHeight: layout.height + commentH,
    renderTopHeader: () => <TopLaneLabels layout={layout} commentsHeight={commentH} />,
    renderCorner: () => <OverviewLabel />,
    renderOverlay: (view: View) => (
      <>
        {grid && (
          <RulerMeters
            view={view}
            grid={grid}
            height={layout.rulerH}
            onOpen={tempoEditable ? openTempoDialog : null}
          />
        )}
        {commentH > 0 && (
          <CommentsLane
            view={view}
            comments={comments}
            top={layout.rulerH + layout.height}
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
