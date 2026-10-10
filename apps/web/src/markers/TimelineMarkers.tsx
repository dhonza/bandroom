import type { Marker } from "@bandroom/shared";
import { Box, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { useLaneVisibility } from "../timeline/laneVisibility";
import type { View } from "../timeline/view";
import { MarkerItem, SectionItem } from "./MarkerItems";
import { layoutFor, type Range } from "./model";
import { SelectionOverlay } from "./SelectionOverlay";
import { useTimelineUi } from "./store";

export { makeSnapper, tapItem } from "./interaction";

/**
 * Lane heights: touch devices get 44 px section lanes (SPEC §11.1 touch targets) and a 36 px
 * ruler; lanes hidden on this device take no space.
 */
export function useMarkerLayout(markers: readonly Marker[]) {
  const coarse = useMediaQuery("(pointer: coarse)", false, { getInitialValueInEffect: false });
  const hidden = useLaneVisibility((s) => s.hidden);
  return layoutFor(markers, coarse, { hidden });
}
export type MarkerLayout = ReturnType<typeof useMarkerLayout>;

/** Everything drawn over the detail timeline: section lanes, markers on the ruler, selection. */
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
  const common = { view, markers, durationSec, onCommit };
  // A hidden Sections lane has no rows: its items are not drawn. Markers are on the ruler.
  const shown = markers.filter((m) => m.type !== "section" || layout.sectionLanes > 0);
  return (
    <>
      {shown.map((m) =>
        m.type === "section" ? (
          <SectionItem
            key={m.id}
            m={m}
            {...common}
            top={layout.rulerH + m.lane * layout.sectionH}
            height={layout.sectionH}
            picked={picked === m.id}
            editable={canEdit(m)}
          />
        ) : (
          <MarkerItem
            key={m.id}
            m={m}
            {...common}
            top={0}
            height={layout.rulerH}
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
    { key: "sections", h: layout.height, label: t("markers.sections") },
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
            <Text size="xs" lh={1.1} c="dimmed" truncate="end">
              {r.label}
            </Text>
          </Box>
        ))}
    </Box>
  );
}

/** The corner left of the overview: what the strip is ("Whole song", SPEC §31.4). */
export function OverviewLabel() {
  const { t } = useTranslation();
  return (
    <Box h="100%" px={4} style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
      <Text size="xs" c="dimmed" lh={1.1} truncate="end">
        {t("timeline.wholeSong")}
      </Text>
    </Box>
  );
}
