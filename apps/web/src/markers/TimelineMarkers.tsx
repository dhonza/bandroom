import type { Marker } from "@bandroom/shared";
import { Box, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { useLaneVisibility } from "../timeline/laneVisibility";
import { RULER_H } from "../timeline/Timeline";
import type { View } from "../timeline/view";
import { MarkerItem, SectionItem } from "./MarkerItems";
import { layoutFor, type Range } from "./model";
import { SelectionOverlay } from "./SelectionOverlay";
import { useTimelineUi } from "./store";

export { makeSnapper, tapItem } from "./interaction";

/**
 * Lane heights: touch devices get 44 px section lanes (SPEC §11.1 touch targets); lanes hidden on
 * this device take no space. `signature`: the song has a tempo map (the time-signature lane).
 */
export function useMarkerLayout(markers: readonly Marker[], signature = false) {
  const coarse = useMediaQuery("(pointer: coarse)", false, { getInitialValueInEffect: false });
  const hidden = useLaneVisibility((s) => s.hidden);
  return layoutFor(markers, coarse, { hidden, signature });
}
export type MarkerLayout = ReturnType<typeof useMarkerLayout>;

/** Everything drawn over the detail timeline: section lanes, markers lane, selection. */
export function MarkersOverlay({
  view,
  markers,
  layout,
  canEdit,
  durationSec,
  height,
  onCommit,
}: {
  view: View;
  markers: readonly Marker[];
  layout: MarkerLayout;
  canEdit: (m: Marker) => boolean;
  durationSec: number;
  height: number;
  onCommit: (m: Marker, r: Range) => void;
}) {
  const selection = useTimelineUi((s) => s.selection);
  const loopOn = useTimelineUi((s) => s.loopOn);
  const picked = useTimelineUi((s) => s.picked);
  const markerTop = RULER_H + layout.markersTop;
  const common = { view, markers, durationSec, onCommit };
  // A hidden lane has no rows: its items are not drawn (sections keep their overview bands).
  const shown = markers.filter((m) =>
    m.type === "section" ? layout.sectionLanes > 0 : layout.markerH > 0,
  );
  return (
    <>
      {shown.map((m) =>
        m.type === "section" ? (
          <SectionItem
            key={m.id}
            m={m}
            {...common}
            top={RULER_H + layout.sectionsTop + m.lane * layout.sectionH}
            height={layout.sectionH}
            picked={picked === m.id}
            editable={canEdit(m)}
          />
        ) : (
          <MarkerItem
            key={m.id}
            m={m}
            {...common}
            top={markerTop}
            height={layout.markerH}
            picked={picked === m.id}
            editable={canEdit(m)}
          />
        ),
      )}
      {selection && (
        <SelectionOverlay
          view={view}
          selection={selection}
          loopOn={loopOn}
          markers={markers}
          durationSec={durationSec}
          height={height}
        />
      )}
    </>
  );
}

/** One label per top lane; a lane without items has height 0 and no row (SPEC §11.3). */
export function TopLaneLabels({
  layout,
  commentsHeight = 0,
}: {
  layout: MarkerLayout;
  commentsHeight?: number;
}) {
  const { t } = useTranslation();
  const rows = [
    { key: "signature", h: layout.signatureH, label: t("markers.signatures") },
    { key: "sections", h: layout.sectionLanes * layout.sectionH, label: t("markers.sections") },
    { key: "markers", h: layout.markerH, label: t("markers.markers") },
    { key: "comments", h: commentsHeight, label: t("comments.lane") },
  ];
  return (
    <Box>
      {rows
        .filter((r) => r.h > 0)
        .map((r) => (
          <Box
            key={r.key}
            h={r.h}
            // Narrow padding: "Komentáře" (cs) fits the 72 px phone label column.
            px={4}
            style={{ display: "flex", alignItems: "center", minWidth: 0 }}
            data-testid={`lane-label-${r.key}`}
          >
            <Text size="xs" c="dimmed" truncate="end">
              {r.label}
            </Text>
          </Box>
        ))}
    </Box>
  );
}
