import type { Song } from "@bandroom/shared";
import { ActionIcon, Button, Group, Text } from "@mantine/core";
import { IconPencil, IconPlus, IconRepeat, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { formatClock } from "../player/format";
import { addSectionFromSelection } from "./actions";
import { BTN } from "./MarkerToolbar";
import { isLoopable, sectionMatching } from "./model";
import { useMarkerPermissions } from "./queries";
import { clearSelection, openEditor, toggleLoop, unpick, useTimelineUi } from "./store";

/** Selection / picked-item bar: range, loop, save as section, edit, clear (SPEC §7.6). */
export function SelectionBar({ song }: { song: Song }) {
  const { t } = useTranslation();
  const selection = useTimelineUi((s) => s.selection);
  const picked = useTimelineUi((s) => s.picked);
  const loopOn = useTimelineUi((s) => s.loopOn);
  const markers = useTimelineUi((s) => s.markers);
  const { canCreate, canEdit } = useMarkerPermissions(song);
  const pickedMarker = markers.find((m) => m.id === picked && m.type === "marker") ?? null;
  const matching = sectionMatching(markers, selection);
  if (pickedMarker) {
    return (
      <Group gap="xs" wrap="wrap" data-testid="selection-bar">
        <Text size="sm" fw={600}>
          {pickedMarker.name} · {formatClock(pickedMarker.startSec)}
        </Text>
        {canEdit(pickedMarker) && (
          <Button
            {...BTN}
            variant="light"
            leftSection={<IconPencil size={16} />}
            onClick={() => {
              openEditor({ mode: "edit", id: pickedMarker.id });
            }}
            data-testid="edit-picked"
          >
            {t("common.edit")}
          </Button>
        )}
        <ActionIcon
          size={44}
          variant="subtle"
          color="gray"
          aria-label={t("markers.clear")}
          onClick={unpick}
        >
          <IconX size={18} />
        </ActionIcon>
      </Group>
    );
  }
  if (!selection) return null;
  return (
    <Group gap="xs" wrap="wrap" data-testid="selection-bar">
      <Text size="sm" className="tabular-nums" data-testid="selection-range">
        {matching ? `${matching.name} · ` : ""}
        {formatClock(selection.start)} – {formatClock(selection.end)} (
        {t("markers.seconds", { value: (selection.end - selection.start).toFixed(1) })})
      </Text>
      <Button
        {...BTN}
        variant={loopOn ? "filled" : "light"}
        color="yellow"
        leftSection={<IconRepeat size={16} />}
        disabled={!isLoopable(selection)}
        onClick={() => {
          toggleLoop();
        }}
        data-testid="selection-loop"
      >
        {loopOn ? t("markers.loopOn") : t("markers.loopThis")}
      </Button>
      {matching && canEdit(matching) ? (
        <Button
          {...BTN}
          variant="light"
          leftSection={<IconPencil size={16} />}
          onClick={() => {
            openEditor({ mode: "edit", id: matching.id });
          }}
          data-testid="edit-picked"
        >
          {t("markers.editSection")}
        </Button>
      ) : (
        canCreate &&
        !matching && (
          <Button
            {...BTN}
            variant="light"
            leftSection={<IconPlus size={16} />}
            onClick={() => {
              addSectionFromSelection();
            }}
            data-testid="save-as-section"
          >
            {t("markers.saveAsSection")}
          </Button>
        )
      )}
      <ActionIcon
        size={44}
        variant="subtle"
        color="gray"
        aria-label={t("markers.clear")}
        onClick={clearSelection}
        data-testid="selection-clear"
      >
        <IconX size={18} />
      </ActionIcon>
    </Group>
  );
}
