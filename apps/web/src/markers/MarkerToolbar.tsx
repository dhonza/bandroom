import type { Song } from "@bandroom/shared";
import { ActionIcon, Box, Menu, Tooltip } from "@mantine/core";
import { IconCheck, IconFlag, IconMagnet, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { LockedHint } from "../features/song/songLock";
import { useTempoUi } from "../tempo/store";
import { TempoButton, TempoMenuItem } from "../tempo/TempoDialog";
import { addSectionFromSelection, useAddMarker } from "./actions";
import { isLoopable, musicalSnap, SNAP_MODES } from "./model";
import { useMarkerPermissions } from "./queries";
import { setSnap, useTimelineUi } from "./store";

/** Size of the selection bar buttons. */
export const BTN = { size: "sm" as const, h: 44 };

/** "Add marker" as an icon (the context row on every device, SPEC §31.1). */
export function AddMarkerButton({ song, size }: { song: Song; size: number }) {
  const { t } = useTranslation();
  const { mayCreate, locked, lockReason } = useMarkerPermissions(song);
  const addMarker = useAddMarker(song);
  if (!mayCreate) return null;
  const button = (
    <ActionIcon
      size={size}
      variant="subtle"
      color="gray"
      disabled={locked}
      aria-label={t("markers.addMarker")}
      onClick={() => {
        addMarker();
      }}
      data-testid="add-marker"
    >
      <IconFlag size={Math.round(size * 0.55)} />
    </ActionIcon>
  );
  if (locked)
    return (
      <LockedHint locked reason={lockReason}>
        {button}
      </LockedHint>
    );
  return <Tooltip label={t("markers.addMarker")}>{button}</Tooltip>;
}

/**
 * The marker tools of the desktop context row (SPEC §7.4, §7.5, §31.1): add marker, add section
 * (from the selection), snap and the tempo map, as icons with tooltips.
 */
export function MarkerToolbar({ song, size }: { song: Song; size: number }) {
  const { t } = useTranslation();
  const { mayCreate, locked, lockReason } = useMarkerPermissions(song);
  const selection = useTimelineUi((s) => s.selection);
  const icon = Math.round(size * 0.55);
  const addSection = (
    <ActionIcon
      size={size}
      variant="subtle"
      color="gray"
      disabled={locked || !selection}
      aria-label={t("markers.addSection")}
      onClick={() => {
        addSectionFromSelection();
      }}
      data-testid="add-section"
    >
      <IconPlus size={icon} />
    </ActionIcon>
  );
  return (
    <Box
      role="group"
      aria-label={t("rehearse.markerTools")}
      style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
      data-testid="marker-toolbar"
    >
      <AddMarkerButton song={song} size={size} />
      {mayCreate &&
        (locked ? (
          <LockedHint locked reason={lockReason}>
            {addSection}
          </LockedHint>
        ) : (
          <Tooltip
            label={isLoopable(selection) ? t("markers.addSection") : t("markers.addSectionHint")}
            multiline
            maw={260}
          >
            {addSection}
          </Tooltip>
        ))}
      <SnapMenu size={size} />
      <TempoButton song={song} size={size} />
    </Box>
  );
}

/** The marker tools in the phone and landscape "⋯" (SPEC §31.1): add section, tempo map. */
export function MarkerMenuItems({ song, withAddMarker }: { song: Song; withAddMarker: boolean }) {
  const { t } = useTranslation();
  const { mayCreate, locked } = useMarkerPermissions(song);
  const addMarker = useAddMarker(song);
  const selection = useTimelineUi((s) => s.selection);
  return (
    <>
      <Menu.Label>{t("rehearse.markerTools")}</Menu.Label>
      {mayCreate && withAddMarker && (
        <Menu.Item
          leftSection={<IconFlag size={14} />}
          closeMenuOnClick
          disabled={locked}
          onClick={() => {
            addMarker();
          }}
          data-testid="add-marker"
        >
          {t("markers.addMarker")}
        </Menu.Item>
      )}
      {mayCreate && (
        <Menu.Item
          leftSection={<IconPlus size={14} />}
          closeMenuOnClick
          disabled={locked || !selection}
          onClick={() => {
            addSectionFromSelection();
          }}
          data-testid="add-section"
        >
          {selection ? t("markers.addSection") : t("markers.addSectionHint")}
        </Menu.Item>
      )}
      <TempoMenuItem song={song} />
    </>
  );
}

/** Snap mode picker (SPEC §7.5): musical modes need a tempo map. */
export function SnapMenu({ size = 44 }: { size?: number }) {
  const { t } = useTranslation();
  const snap = useTimelineUi((s) => s.snap);
  const hasTempo = useTempoUi((s) => s.grid !== null);
  const shown = !hasTempo && musicalSnap(snap) ? "markers" : snap;
  const label = t("markers.snapLabel", { mode: t(`markers.snap.${shown}`) });
  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <Tooltip label={label}>
          <ActionIcon
            size={size}
            variant="subtle"
            color="gray"
            data-testid="snap-mode"
            aria-label={label}
          >
            <IconMagnet size={Math.round(size * 0.55)} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t("markers.snapTitle")}</Menu.Label>
        {SNAP_MODES.map((m) => (
          <Menu.Item
            key={m}
            disabled={!hasTempo && musicalSnap(m) !== null}
            leftSection={m === shown ? <IconCheck size={14} /> : <Box w={14} />}
            onClick={() => {
              setSnap(m);
            }}
            fw={m === shown ? 700 : undefined}
            data-testid={`snap-${m}`}
          >
            {t(`markers.snap.${m}`)}
          </Menu.Item>
        ))}
        {!hasTempo && <Menu.Label>{t("markers.snapMusicalLater")}</Menu.Label>}
      </Menu.Dropdown>
    </Menu>
  );
}
