import type { Song } from "@bandroom/shared";
import { Button, Group, Menu, Tooltip } from "@mantine/core";
import { IconFlag, IconMagnet, IconPlus } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { LockedHint } from "../features/song/songLock";
import { useTempoUi } from "../tempo/store";
import { TempoButton } from "../tempo/TempoDialog";
import { addSectionFromSelection, useAddMarker } from "./actions";
import { isLoopable, musicalSnap, SNAP_MODES } from "./model";
import { useMarkerPermissions } from "./queries";
import { setSnap, useTimelineUi } from "./store";

/** Size of the marker toolbar and selection bar buttons. */
export const BTN = { size: "sm" as const, h: 44 };

/** "+ Marker", "+ Section" and the snap mode (SPEC §7.4, §7.5). */
export function MarkerToolbar({ song }: { song: Song }) {
  const { t } = useTranslation();
  const { mayCreate, locked } = useMarkerPermissions(song);
  const addMarker = useAddMarker(song);
  const selection = useTimelineUi((s) => s.selection);
  return (
    <Group gap="xs" wrap="wrap" data-testid="marker-toolbar">
      {mayCreate && (
        <LockedHint locked={locked}>
          <Group gap="xs" wrap="wrap">
            <Button
              {...BTN}
              variant="default"
              leftSection={<IconFlag size={16} />}
              disabled={locked}
              onClick={() => {
                addMarker();
              }}
              data-testid="add-marker"
            >
              {t("markers.addMarker")}
            </Button>
            <Tooltip
              label={t("markers.addSectionHint")}
              disabled={locked || isLoopable(selection)}
              multiline
              maw={260}
            >
              <Button
                {...BTN}
                variant="default"
                leftSection={<IconPlus size={16} />}
                disabled={locked || !selection}
                onClick={() => {
                  addSectionFromSelection();
                }}
                data-testid="add-section"
              >
                {t("markers.addSection")}
              </Button>
            </Tooltip>
          </Group>
        </LockedHint>
      )}
      <SnapMenu />
      <TempoButton song={song} />
    </Group>
  );
}

/** Snap mode picker (SPEC §7.5): musical modes need a tempo map. */
export function SnapMenu() {
  const { t } = useTranslation();
  const snap = useTimelineUi((s) => s.snap);
  const hasTempo = useTempoUi((s) => s.grid !== null);
  const shown = !hasTempo && musicalSnap(snap) ? "markers" : snap;
  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <Button
          {...BTN}
          variant="subtle"
          color="gray"
          leftSection={<IconMagnet size={16} />}
          data-testid="snap-mode"
          aria-label={t("markers.snapLabel", { mode: t(`markers.snap.${shown}`) })}
        >
          {t(`markers.snap.${shown}`)}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t("markers.snapTitle")}</Menu.Label>
        {SNAP_MODES.map((m) => (
          <Menu.Item
            key={m}
            disabled={!hasTempo && musicalSnap(m) !== null}
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
