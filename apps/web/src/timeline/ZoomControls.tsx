import { ActionIcon, Group, Tooltip } from "@mantine/core";
import {
  IconArrowsHorizontal,
  IconViewportShort,
  IconViewportTall,
  IconZoomIn,
  IconZoomInArea,
  IconZoomOut,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

/** Lane height buttons (vertical zoom, SPEC §25.9); a disabled button is at its limit. */
export interface LaneZoom {
  shorter: (() => void) | null;
  taller: (() => void) | null;
}

/**
 * Below the timeline: lane height (shorter/taller) on the left; zoom out, fit the whole song and
 * zoom in on the right.
 */
export function ZoomControls({
  onZoom,
  onFit,
  onZoomToRange,
  lanes,
}: {
  onZoom: (factor: number) => void;
  onFit: () => void;
  /** Zoom to the loop or selection; null (disabled) when there is neither. */
  onZoomToRange: (() => void) | null;
  lanes?: LaneZoom | undefined;
}) {
  const { t } = useTranslation();
  return (
    <Group gap={4} justify="flex-end" mt={4} wrap="nowrap">
      {lanes && (
        <Group gap={4} mr="auto" wrap="nowrap">
          <Tooltip label={t("timeline.lanesShorter")}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size={44}
              aria-label={t("timeline.lanesShorter")}
              disabled={!lanes.shorter}
              onClick={lanes.shorter ?? undefined}
              data-testid="lanes-shorter"
            >
              <IconViewportShort size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t("timeline.lanesTaller")}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size={44}
              aria-label={t("timeline.lanesTaller")}
              disabled={!lanes.taller}
              onClick={lanes.taller ?? undefined}
              data-testid="lanes-taller"
            >
              <IconViewportTall size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      )}
      <Tooltip label={t("timeline.zoomOut")}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={44}
          aria-label={t("timeline.zoomOut")}
          onClick={() => {
            onZoom(1 / 1.5);
          }}
        >
          <IconZoomOut size={18} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={t("timeline.fit")}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={44}
          aria-label={t("timeline.fit")}
          onClick={onFit}
        >
          <IconArrowsHorizontal size={18} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={t("timeline.zoomToLoop")}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={44}
          aria-label={t("timeline.zoomToLoop")}
          disabled={!onZoomToRange}
          onClick={onZoomToRange ?? undefined}
          data-testid="zoom-to-loop"
        >
          <IconZoomInArea size={18} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={t("timeline.zoomIn")}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={44}
          aria-label={t("timeline.zoomIn")}
          onClick={() => {
            onZoom(1.5);
          }}
        >
          <IconZoomIn size={18} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
