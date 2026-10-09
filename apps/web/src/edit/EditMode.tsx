import type { Song, Track } from "@bandroom/shared";
import { Alert, Button, Group, Stack, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCut } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api/client";
import { useApiError } from "../api/useApiError";
import { AppModal } from "../components/ResponsivePanel";
import { useSongTracks } from "../features/library/queries";
import { LockedHint } from "../features/song/songLock";
import { useFormatters } from "../i18n/format";
import { useTimelineUi } from "../markers/store";
import { prepareEngine, usePlayerView } from "../rehearse/controller";
import { ApplyProgress } from "./ApplyBounce";
import { EditHeaderBar, EditToolbar } from "./EditToolbar";
import { cancelEdit, editKeys, startEdit, takeOverEdit } from "./session";
import { useEdit } from "./store";

/** The song page is in edit mode for `songId` (this user holds the session). */
export function useEditingSong(songId: string): boolean {
  return useEdit((s) => s.songId === songId && s.session !== null);
}

/** Who may edit: the `audio.edit` capability (editors, SPEC §24.12). */
export function mayEditAudio(song: Song): boolean {
  return song.access.capabilities.includes("audio.edit");
}

/**
 * "Edit audio" in the song header (SPEC §24.7): starts an edit session. Disabled while the song
 * is locked or has no playable track; hidden while someone else edits (the banner offers the
 * takeover).
 */
export function EditButton({ song, tracks }: { song: Song; tracks: Track[] | null }) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (!mayEditAudio(song) || song.editing) return null;
  const locked = song.locked !== null;
  const playable = (tracks ?? []).some((tr) => tr.current?.status === "ready");
  const start = async () => {
    // Inside the tap: the audio unlocks (iOS) and a previewed song moves into the engine.
    prepareEngine();
    setBusy(true);
    try {
      await startEdit(qc, song.id, tracks ?? []);
    } catch (err) {
      notifications.show({ color: "red", message: apiError(err) });
      if (err instanceof ApiError && err.code === "EDIT_SESSION_OPEN") {
        void qc.invalidateQueries({ queryKey: editKeys.session(song.id) });
        void qc.invalidateQueries({ queryKey: ["songs", song.id], exact: true });
      }
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
export function EditModeHeader({ song }: { song: Song }) {
  const qc = useQueryClient();
  const tracks = useSongTracks(song.id).data?.tracks;
  const names = useMemo(
    () => Object.fromEntries((tracks ?? []).map((tr) => [tr.id, tr.name])),
    [tracks],
  );
  const onCancel = async () => {
    const id = useEdit.getState().session?.id;
    if (id) await cancelEdit(qc, id, song.id);
  };
  return <EditHeaderBar onCancel={onCancel} trackNames={names} songTitle={song.title} />;
}

/**
 * The toolbar under the header (desktop) or the bottom sheet (phones), and the progress of a
 * running (or failed) Apply/Bounce above it.
 */
export function EditModeToolbar() {
  const markers = useTimelineUi((s) => s.markers);
  const durationSec = usePlayerView((s) => s.timelineSec);
  return (
    <>
      <ApplyProgress />
      <EditToolbar markers={markers} durationSec={durationSec} />
    </>
  );
}

/**
 * Others see who edits the song (SPEC §24.6): "Being edited by Jana since 14:02"; they hear the
 * unedited song and frozen changes are refused. Editors may take the session over or cancel it
 * (both confirmed).
 */
export function EditBanner({ song, tracks }: { song: Song; tracks: Track[] | null }) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const qc = useQueryClient();
  const apiError = useApiError();
  const mine = useEditingSong(song.id);
  const [confirm, setConfirm] = useState<"takeOver" | "cancel" | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = song.editing;
  if (!editing || mine) return null;
  const name = editing.by.name;
  const time = fmt.dateTime(editing.since);
  // While Apply/Bounce renders (SPEC §24.8) the banner says so; a takeover waits for it.
  const applying = editing.status === "applying";
  const title = applying
    ? name
      ? t("edit.bannerApplying", { name })
      : t("edit.bannerApplyingNoName")
    : name
      ? t("edit.banner", { name, time })
      : t("edit.bannerNoName", { time });
  const canAct = mayEditAudio(song) && editing.sessionId !== null;
  const run = async () => {
    const id = editing.sessionId;
    if (!id || !confirm) return;
    setBusy(true);
    try {
      if (confirm === "takeOver") {
        prepareEngine();
        await takeOverEdit(qc, id, song.id, tracks ?? []);
      } else await cancelEdit(qc, id, song.id);
      setConfirm(null);
    } catch (err) {
      notifications.show({ color: "red", message: apiError(err) });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["songs", song.id], exact: true });
    }
  };
  return (
    <Alert
      color="orange"
      variant="light"
      icon={<IconCut size={18} />}
      title={title}
      data-testid="edit-banner"
      data-status={editing.status}
    >
      <Stack gap="xs">
        <Text size="sm">{applying ? t("edit.bannerApplyingBody") : t("edit.bannerBody")}</Text>
        {canAct && (
          <Group gap="xs">
            {!applying && (
              <Button
                variant="light"
                h={44}
                onClick={() => {
                  setConfirm("takeOver");
                }}
                data-testid="edit-take-over"
              >
                {t("edit.takeOver")}
              </Button>
            )}
            <Button
              variant="subtle"
              color="red"
              h={44}
              onClick={() => {
                setConfirm("cancel");
              }}
              data-testid="edit-cancel-other"
            >
              {t("edit.cancelSession")}
            </Button>
          </Group>
        )}
      </Stack>
      <AppModal
        opened={confirm !== null}
        onClose={() => {
          setConfirm(null);
        }}
        title={
          confirm === "takeOver"
            ? t("edit.takeOverTitle")
            : t("edit.cancelSessionTitle", { name: name ?? "" })
        }
        centered
        data-testid="edit-session-confirm"
      >
        <Stack>
          <Text>
            {confirm === "takeOver"
              ? t("edit.takeOverBody", { name: name ?? "" })
              : t("edit.cancelSessionBody")}
          </Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                setConfirm(null);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              color={confirm === "cancel" ? "red" : undefined}
              loading={busy}
              onClick={() => {
                void run();
              }}
              data-testid="edit-session-confirm-ok"
            >
              {confirm === "takeOver" ? t("edit.takeOver") : t("edit.cancelSession")}
            </Button>
          </Group>
        </Stack>
      </AppModal>
    </Alert>
  );
}
