import type { Song, Track } from "@bandroom/shared";
import { Button, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCut } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApiError } from "../api/useApiError";
import { LockedHint } from "../features/song/songLock";
import { useTimelineUi } from "../markers/store";
import { prepareEngine, usePlayerView } from "../rehearse/controller";
import { EditHeaderBar, EditToolbar } from "./EditToolbar";
import { cancelEditSession, startEditSession } from "./session";
import { useEdit } from "./store";

/** The song page is in edit mode for `songId` (this user holds the session). */
export function useEditingSong(songId: string): boolean {
  return useEdit((s) => s.songId === songId && s.session !== null);
}

/** Who may edit: the `audio.edit` capability (editors, SPEC §24.12). */
export function mayEditAudio(song: Song): boolean {
  return song.access.capabilities.includes("edit.any");
}

/**
 * "Edit" in the song header (SPEC §24.7): starts (or continues) an edit session. Disabled while
 * the song is locked or has no playable track.
 */
export function EditButton({ song, tracks }: { song: Song; tracks: Track[] | null }) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const [busy, setBusy] = useState(false);
  if (!mayEditAudio(song)) return null;
  const locked = song.locked !== null;
  const playable = (tracks ?? []).some((tr) => tr.current?.status === "ready");
  const start = async () => {
    // Inside the tap: the audio unlocks (iOS) and a previewed song moves into the engine.
    prepareEngine();
    setBusy(true);
    try {
      if (!(await startEditSession(song.id, tracks ?? [])))
        notifications.show({ color: "red", message: t("edit.startFailed") });
    } catch (err) {
      notifications.show({ color: "red", message: apiError(err) });
    } finally {
      setBusy(false);
    }
  };
  const button = (
    <Button
      variant="default"
      h={44}
      leftSection={<IconCut size={16} />}
      disabled={locked || !playable}
      loading={busy}
      onClick={() => {
        void start();
      }}
      data-testid="edit-audio"
    >
      {t("edit.button")}
    </Button>
  );
  if (locked) return <LockedHint locked>{button}</LockedHint>;
  return (
    <Tooltip label={t("edit.buttonHint")} multiline w={260}>
      {button}
    </Tooltip>
  );
}

/** The song header in edit mode: the edit bar instead of the actions. */
export function EditModeHeader(_props: { song: Song }) {
  return <EditHeaderBar onCancel={cancelEditSession} />;
}

/** The toolbar under the header (desktop) or the bottom sheet (phones). */
export function EditModeToolbar() {
  const markers = useTimelineUi((s) => s.markers);
  const durationSec = usePlayerView((s) => s.timelineSec);
  return <EditToolbar markers={markers} durationSec={durationSec} />;
}
