import type { Marker } from "@bandroom/shared";
import { Box, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useTranslation } from "react-i18next";
import { RULER_H } from "../timeline/Timeline";
import type { View } from "../timeline/view";
import { MarkerItem, SectionItem } from "./MarkerItems";
import { layoutFor, type Range } from "./model";
import { SelectionOverlay } from "./SelectionOverlay";
import { useTimelineUi } from "./store";

export { makeSnapper, tapItem } from "./interaction";

/** Lane heights: touch devices get 44 px section lanes (SPEC §11.1 touch targets). */
export function useMarkerLayout(markers: readonly Marker[]) {
  const coarse = useMediaQuery("(pointer: coarse)", false, { getInitialValueInEffect: false });
  return layoutFor(markers, coarse);
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
  const markerTop = RULER_H + layout.sectionLanes * layout.sectionH;
  const common = { view, markers, durationSec, onCommit };
  return (
    <>
      {markers.map((m) =>
        m.type === "section" ? (
          <SectionItem
            key={m.id}
            m={m}
            {...common}
            top={RULER_H + m.lane * layout.sectionH}
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

/** Labels of the top lanes in the desktop track-header column. */
export function TopLaneLabels({
  layout,
  commentsHeight = 0,
}: {
  layout: MarkerLayout;
  commentsHeight?: number;
}) {
  const { t } = useTranslation();
  return (
    <Box>
      <Box
        h={layout.sectionLanes * layout.sectionH}
        px="xs"
        style={{ display: "flex", alignItems: "center" }}
      >
        <Text size="xs" c="dimmed">
          {t("markers.sections")}
        </Text>
      </Box>
      <Box h={layout.markerH} px="xs" style={{ display: "flex", alignItems: "center" }}>
        <Text size="xs" c="dimmed">
          {t("markers.markers")}
        </Text>
      </Box>
      {commentsHeight > 0 && (
        <Box h={commentsHeight} px="xs" style={{ display: "flex", alignItems: "center" }}>
          <Text size="xs" c="dimmed">
            {t("comments.lane")}
          </Text>
        </Box>
      )}
    </Box>
  );
}
