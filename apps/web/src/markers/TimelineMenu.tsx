import type { Song } from "@bandroom/shared";
import { Menu } from "@mantine/core";
import {
  IconEdit,
  IconFlag,
  IconListDetails,
  IconMessagePlus,
  IconPlus,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { commentAtPlayhead } from "../comments/actions";
import { formatClock } from "../player/format";
import { useAddMarker } from "./actions";
import { MenuAnchor } from "./MenuAnchor";
import { sectionRangeFrom } from "./model";
import { useCommentPermissions } from "../comments/queries";
import { useMarkerPermissions } from "./queries";
import { openEditor, seekTo, setItemsOpen, setSelection, useTimelineUi } from "./store";
import type { TimelineMenuState } from "./useTimelineMarkers";

/**
 * The timeline menu (long-press on touch, right click with a mouse): add a marker or start a
 * section here (SPEC §7.4), and edit the marker or section it was opened on (SPEC §25.7).
 */
export function TimelineMenu({
  song,
  menu,
  onClose,
  durationSec,
}: {
  song: Song;
  menu: TimelineMenuState | null;
  onClose: () => void;
  durationSec: number;
}) {
  const { t } = useTranslation();
  const { canCreate } = useMarkerPermissions(song);
  const { canComment } = useCommentPermissions(song);
  const addMarker = useAddMarker(song);
  const editItem = useTimelineUi((s) =>
    menu?.editId ? s.markers.find((m) => m.id === menu.editId) : undefined,
  );
  if (!menu) return null;
  const startSection = () => {
    const range = sectionRangeFrom(useTimelineUi.getState().markers, menu.sec, durationSec);
    setSelection(range);
    openEditor({ mode: "create", type: "section", range });
  };
  return (
    <Menu
      opened
      onChange={(o) => {
        if (!o) onClose();
      }}
      withinPortal
      position="bottom-start"
    >
      <Menu.Target>
        {/* An invisible anchor at the tap: a button role for the menu's aria attributes. */}
        <MenuAnchor style={{ position: "fixed", left: menu.x, top: menu.y, width: 1, height: 1 }} />
      </Menu.Target>
      <Menu.Dropdown data-testid="timeline-menu">
        <Menu.Label>{formatClock(menu.sec)}</Menu.Label>
        {editItem && (
          <Menu.Item
            leftSection={<IconEdit size={14} />}
            onClick={() => {
              openEditor({ mode: "edit", id: editItem.id });
            }}
            data-testid="menu-edit-item"
          >
            {t("markers.editItem", { name: editItem.name })}
          </Menu.Item>
        )}
        <Menu.Item
          onClick={() => {
            seekTo(menu.sec);
          }}
        >
          {t("markers.jumpHere")}
        </Menu.Item>
        {canCreate && (
          <>
            <Menu.Item
              leftSection={<IconFlag size={14} />}
              onClick={() => {
                addMarker(menu.sec);
              }}
            >
              {t("markers.addMarkerHere")}
            </Menu.Item>
            <Menu.Item leftSection={<IconPlus size={14} />} onClick={startSection}>
              {t("markers.startSectionHere")}
            </Menu.Item>
          </>
        )}
        {canComment && (
          <Menu.Item
            leftSection={<IconMessagePlus size={14} />}
            onClick={() => {
              commentAtPlayhead(menu.sec);
            }}
            data-testid="menu-add-comment"
          >
            {t("comments.addHere")}
          </Menu.Item>
        )}
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconListDetails size={14} />}
          onClick={() => {
            setItemsOpen(true);
          }}
          data-testid="menu-timeline-items"
        >
          {t("timelineItems.open")}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
