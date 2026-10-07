import type { Song } from "@bandroom/shared";
import { Group, Kbd, Modal, Stack, Table, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { requestZoom, requestZoomToRange } from "../timeline/Timeline";
import { loadKeyMap, resolveKey, type Resolved } from "./keymap";
import { useCommentPermissions } from "../comments/queries";
import { useMarkerPermissions } from "./queries";
import { addSectionFromSelection, useAddMarker } from "./SongMarkers";
import { commentAtPlayhead } from "../comments/actions";
import { turnPage } from "../documents/store";
import {
  clearSelection,
  cycleSnap,
  goNext,
  goPrev,
  nudgeBy,
  playPause,
  returnToStart,
  setHelpOpen,
  toggleLoop,
  unpick,
  useTimelineUi,
} from "./store";

export interface ShortcutExtras {
  /** `V`: A/B toggle (Rehearse). */
  onAB?: () => void;
  /** `1–9` (Alt: mute, Shift: solo) (Rehearse). */
  onTrack?: (index: number, op: "select" | "mute" | "solo") => void;
  /** `K` / `C`: count-in and click (Rehearse); false when there is no tempo map. */
  onCountIn?: () => boolean;
  onClick?: () => boolean;
}

function ignoredTarget(e: KeyboardEvent, r: Resolved): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  if (el.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]"))
    return true;
  // A focused document viewer turns pages with these keys itself (SPEC §11.4).
  if (el.closest("[data-doc-viewer]")) return true;
  // Buttons keep Space/Enter; sliders keep the arrows.
  const activates = r.action === "playPause" || r.action === "returnToStart";
  if (activates && el.closest("button, [role=button], a")) return true;
  const arrows = r.action.startsWith("nudge");
  return arrows && el.closest("[role=slider]") !== null;
}

/**
 * Song page keyboard and pedal shortcuts (SPEC §11.4). A pedal
 * mapping from Settings → Keyboard overrides the defaults for its keys.
 */
export function useSongShortcuts(song: Song, extras: ShortcutExtras = {}): void {
  const { t } = useTranslation();
  const addMarker = useAddMarker(song);
  const { canCreate } = useMarkerPermissions(song);
  const { canComment } = useCommentPermissions(song);
  const { onAB, onTrack, onCountIn, onClick } = extras;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const r = resolveKey(e, loadKeyMap());
      if (!r || ignoredTarget(e, r)) return;
      let handled = true;
      switch (r.action) {
        case "playPause":
          playPause();
          break;
        case "returnToStart":
          returnToStart();
          break;
        case "prev":
          goPrev();
          break;
        case "next":
          goNext();
          break;
        case "nudgeBack":
        case "nudgeBackBig":
          nudgeBy(-1, r.action === "nudgeBackBig");
          break;
        case "nudgeForward":
        case "nudgeForwardBig":
          nudgeBy(1, r.action === "nudgeForwardBig");
          break;
        case "toggleLoop":
          toggleLoop();
          break;
        case "cycleSnap": {
          const mode = cycleSnap();
          notifications.show({
            id: "snap-mode",
            message: t("markers.snapLabel", { mode: t(`markers.snap.${mode}`) }),
            autoClose: 1500,
          });
          break;
        }
        case "addMarker":
          if (canCreate) addMarker();
          break;
        case "addSection":
          if (canCreate) addSectionFromSelection();
          break;
        case "abToggle":
          onAB?.();
          break;
        case "track":
          onTrack?.(r.index, r.op);
          break;
        case "zoomIn":
          requestZoom(1.5);
          break;
        case "zoomOut":
          requestZoom(1 / 1.5);
          break;
        case "zoomToLoop":
          requestZoomToRange();
          break;
        case "help":
          setHelpOpen(true);
          break;
        case "clearSelection":
          if (useTimelineUi.getState().picked) unpick();
          else clearSelection();
          break;
        case "toggleCountIn":
        case "toggleClick": {
          const fn = r.action === "toggleClick" ? onClick : onCountIn;
          if (!fn) {
            handled = false;
          } else if (!fn()) {
            notifications.show({ id: "click-mode", message: t("click.noTempo") });
          }
          break;
        }
        case "comment":
          if (canComment) commentAtPlayhead();
          else handled = false;
          break;
        case "pageNext":
        case "pagePrev":
          handled = turnPage(r.action === "pageNext" ? "next" : "prev");
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [addMarker, canCreate, canComment, onAB, onTrack, onCountIn, onClick, t]);
}

type HelpAction =
  | "playPause"
  | "returnToStart"
  | "prevNext"
  | "nudge"
  | "nudgeBig"
  | "toggleLoop"
  | "toggleCountIn"
  | "toggleClick"
  | "cycleSnap"
  | "addMarker"
  | "addSection"
  | "comment"
  | "abToggle"
  | "selectTrack"
  | "muteTrack"
  | "soloTrack"
  | "zoom"
  | "zoomToLoop"
  | "clearSelection"
  | "pageTurn"
  | "toggleChrome"
  | "help";

const HELP_ROWS: [string[], HelpAction][] = [
  [["Space"], "playPause"],
  [["Enter"], "returnToStart"],
  [["[", "]"], "prevNext"],
  [["←", "→"], "nudge"],
  [["Shift", "←/→"], "nudgeBig"],
  [["L"], "toggleLoop"],
  [["K"], "toggleCountIn"],
  [["C"], "toggleClick"],
  [["S"], "cycleSnap"],
  [["M"], "addMarker"],
  [["Shift", "M"], "addSection"],
  [["N"], "comment"],
  [["V"], "abToggle"],
  [["1–9"], "selectTrack"],
  [["Alt", "1–9"], "muteTrack"],
  [["Shift", "1–9"], "soloTrack"],
  [["+", "−"], "zoom"],
  [["Z"], "zoomToLoop"],
  [["Esc"], "clearSelection"],
  [["PgDn", "PgUp"], "pageTurn"],
  [["Shift", "F"], "toggleChrome"],
  [["?"], "help"],
];

/** `?` — the shortcut list. */
export function ShortcutHelp() {
  const { t } = useTranslation();
  const open = useTimelineUi((s) => s.helpOpen);
  return (
    <Modal
      opened={open}
      onClose={() => {
        setHelpOpen(false);
      }}
      title={t("shortcuts.title")}
      centered
      data-testid="shortcut-help"
    >
      <Stack gap="xs">
        <Table>
          <Table.Tbody>
            {HELP_ROWS.map(([keys, action]) => (
              <Table.Tr key={action}>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    {keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </Group>
                </Table.Td>
                <Table.Td>{t(`shortcuts.actions.${action}`)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Text size="sm" c="dimmed">
          {t("shortcuts.pedalHint")}
        </Text>
      </Stack>
    </Modal>
  );
}
