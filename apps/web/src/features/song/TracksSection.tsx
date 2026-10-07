import {
  canCopyContent,
  canDeleteContent,
  canMoveContent,
  canRemoveLossless,
  type BatchItems,
  type Song,
  type Track,
} from "@bandroom/shared";
import { Alert, Button, Group, Loader, Stack, Text, ThemeIcon } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { notifications } from "@mantine/notifications";
import {
  IconArrowsTransferUp,
  IconStack2,
  IconDiamondOff,
  IconListCheck,
  IconTrash,
  IconUpload,
  IconWaveSine,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMediaQuery } from "@mantine/hooks";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOnline } from "../../offline/online";
import { Section } from "../../components/Section";
import { isProbablyAudio, proposeMatches, type MatchProposal } from "../../lib/media";
import { startUpload } from "../../upload/startUpload";
import { useUploads } from "../../upload/uploadStore";
import {
  isDocumentUpload,
  UploadRow,
  useUploadErrorText,
  useUploadErrorToast,
} from "../../upload/UploadRow";
import { songKeys, useSongTracks } from "../library/queries";
import { MatchDialog } from "./MatchDialog";
import { uploadTargetFor } from "./model";
import { TrackRow } from "./TrackRow";
import { errorMessage } from "../../api/errorMessage";
import { useCurrentUser } from "../../auth/session";
import { SelectionBar } from "../../selection/SelectionBar";
import { trackSelection } from "../../selection/store";
import { useSelection } from "../../selection/useSelection";
import { useBatchDelete } from "../../trash/queries";
import { FINE_POINTER_QUERY } from "../project/SongsList";
import { RemoveLosslessDialog } from "../../lossless/RemoveLosslessDialog";
import { MultitrackDialog, type MultitrackRequest } from "../../transfer/MultitrackDialog";

export function TracksSection({ song }: { song: Song }) {
  const { t } = useTranslation();
  const online = useOnline();
  const qc = useQueryClient();
  const errorText = useUploadErrorText();
  const uploadErrorToast = useUploadErrorToast();
  const tracks = useSongTracks(song.id);
  // Select the stable array, filter outside the selector (a new array per call would loop).
  const allUploads = useUploads((s) => s.items);
  const uploads = useMemo(
    () =>
      allUploads.filter((i) => i.songId === song.id && i.status !== "done" && !isDocumentUpload(i)),
    [allUploads, song.id],
  );
  const canUpload = song.access.capabilities.includes("upload");

  const list = tracks.data?.tracks ?? [];
  const user = useCurrentUser();
  const finePointer = useMediaQuery(FINE_POINTER_QUERY, false);
  const selection = useSelection(
    trackSelection,
    `song:${song.id}`,
    list.map((tr) => tr.id),
  );
  const batchDelete = useBatchDelete();
  const [deleting, setDeleting] = useState(false);
  // Batch actions (SPEC §26.1): delete own tracks (contributors) or any (editors).
  const canDeleteTrack = (tr: Track) =>
    canDeleteContent(song.access.role, "track", tr.createdBy === user.id);
  // Remove full quality (SPEC §26.4) applies per version: managers any track, uploaders a
  // track whose only version is theirs (the server checks every version).
  const canRemoveTrack = (tr: Track) =>
    canRemoveLossless(
      song.access.role,
      tr.versionCount === 1 && tr.current?.uploadedBy === user.id,
    );
  const [removeItems, setRemoveItems] = useState<BatchItems | null>(null);
  const [multitrack, setMultitrack] = useState<MultitrackRequest | null>(null);
  const role = song.access.role;
  // Make multitrack song / copy / move (SPEC §26.5, §26.6): moving needs the delete rights on
  // the tracks, and moving every track out (the song then goes to the Trash) the song's.
  const canMoveTrack = (tr: Track) => canMoveContent(role, "track", tr.createdBy === user.id);
  const selectable = list.some(
    (tr) => canDeleteTrack(tr) || canRemoveTrack(tr) || canMoveTrack(tr) || canCopyContent(role),
  );
  const selected = list.filter((tr) => selection.ids.has(tr.id));
  const deletable = selected.filter(canDeleteTrack);
  const removable = selected.filter(canRemoveTrack);
  const emptiesSong = selected.length === list.length && !canDeleteContent(role, "song", false);
  const movable = emptiesSong ? [] : selected.filter(canMoveTrack);
  const copyable = canCopyContent(role) ? selected : [];
  const mergeable = song.access.capabilities.includes("song.create") ? movable : [];
  const moveReason = emptiesSong
    ? t("transfer.emptyNeedsManager")
    : t("selection.notYours", { count: selected.length - movable.length });
  const deleteSelected = async () => {
    setDeleting(true);
    const ok = await batchDelete({ tracks: deletable.map((tr) => tr.id) });
    setDeleting(false);
    if (ok) selection.exit();
  };
  const [pending, setPending] = useState<{ files: File[]; proposals: MatchProposal[] } | null>(
    null,
  );

  const upload = (file: File, proposal: MatchProposal) => {
    startUpload(file, uploadTargetFor(song.id, proposal), {
      songId: song.id,
      projectId: song.project.id,
    })
      .then(() => qc.invalidateQueries({ queryKey: songKeys.tracks(song.id) }))
      .catch((err: unknown) => {
        uploadErrorToast(err, file.name);
      });
  };

  /** New tracks for an empty song; otherwise confirm matches to existing tracks (SPEC §5.1). */
  const uploadFiles = (files: File[]) => {
    const audio = files.filter(isProbablyAudio);
    if (audio.length < files.length)
      notifications.show({ color: "yellow", message: t("tracks.skippedNonAudio") });
    if (audio.length === 0) return;
    const proposals = proposeMatches(
      audio.map((f) => f.name),
      list,
    );
    if (list.length === 0) {
      audio.forEach((file, i) => {
        const p = proposals[i];
        if (p) upload(file, p);
      });
    } else {
      setPending({ files: audio, proposals });
    }
  };
  return (
    <Section title={t("tracks.title")} testId="tracks-section">
      {canUpload && (
        <Dropzone
          onDrop={uploadFiles}
          disabled={!online}
          multiple
          radius="md"
          p="lg"
          data-testid="track-dropzone"
          aria-label={t("tracks.dropHint")}
        >
          <Group justify="center" gap="md" mih={64} style={{ pointerEvents: "none" }}>
            <IconUpload size={28} aria-hidden />
            <Stack gap={0}>
              <Text fw={500}>
                {online ? t("tracks.dropHint") : t("offline.uploadNeedsNetwork")}
              </Text>
              <Text size="xs" c="dimmed">
                {t("tracks.dropFormats")}
              </Text>
            </Stack>
          </Group>
        </Dropzone>
      )}

      {uploads.map((u) => (
        <UploadRow key={u.id} item={u} errorText={errorText} />
      ))}

      {tracks.isPending ? (
        <Loader size="sm" />
      ) : tracks.isError ? (
        <Alert color="red">{errorMessage(t, tracks.error)}</Alert>
      ) : list.length === 0 && uploads.length === 0 ? (
        <Group gap="sm" c="dimmed">
          <ThemeIcon variant="light" radius="xl">
            <IconWaveSine size={18} aria-hidden />
          </ThemeIcon>
          <Text size="sm">{t("tracks.empty")}</Text>
        </Group>
      ) : (
        <Stack gap="xs" data-testid="track-list">
          {selectable && !selection.active && (
            <Group justify="flex-end">
              <Button
                variant="default"
                size="compact-sm"
                h={44}
                leftSection={<IconListCheck size={16} />}
                onClick={() => {
                  selection.start();
                }}
                data-testid="tracks-select"
              >
                {t("selection.select")}
              </Button>
            </Group>
          )}
          {list.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              song={song}
              selection={
                selectable
                  ? {
                      selecting: selection.active,
                      selected: selection.ids.has(track.id),
                      showCheckbox: selection.active || finePointer,
                      onToggle: () => {
                        selection.toggle(track.id);
                      },
                    }
                  : undefined
              }
            />
          ))}
          {selection.active && (
            <SelectionBar
              testId="tracks-selection-bar"
              count={selected.length}
              total={list.length}
              onSelectAll={() => {
                selection.setAll(list.map((tr) => tr.id));
              }}
              onExit={selection.exit}
              actions={[
                {
                  key: "delete",
                  label: t("selection.delete"),
                  icon: <IconTrash size={16} />,
                  color: "red",
                  allowed: deletable.length,
                  reason: t("selection.notYours", { count: selected.length - deletable.length }),
                  loading: deleting,
                  onClick: () => {
                    void deleteSelected();
                  },
                },
                {
                  key: "removeLossless",
                  label: t("lossless.action"),
                  icon: <IconDiamondOff size={16} />,
                  allowed: removable.length,
                  reason: t("lossless.notAllowed", {
                    count: selected.length - removable.length,
                  }),
                  onClick: () => {
                    setRemoveItems({ tracks: removable.map((tr) => tr.id) });
                  },
                },
                {
                  key: "makeMultitrack",
                  label: t("transfer.makeMultitrack"),
                  icon: <IconStack2 size={16} />,
                  allowed: mergeable.length,
                  reason: moveReason,
                  onClick: () => {
                    setMultitrack({
                      items: { tracks: mergeable.map((tr) => tr.id) },
                      mode: "move",
                      projectId: song.project.id,
                    });
                  },
                },
                {
                  key: "copyMove",
                  label: t("transfer.copyMove"),
                  icon: <IconArrowsTransferUp size={16} />,
                  allowed: Math.max(copyable.length, movable.length),
                  reason: moveReason,
                  onClick: () => undefined,
                  menu: [
                    {
                      key: "copyTo",
                      label: t("transfer.copyTracksTo"),
                      allowed: copyable.length,
                      onClick: () => {
                        setMultitrack({
                          items: { tracks: copyable.map((tr) => tr.id) },
                          mode: "copy",
                          projectId: null,
                        });
                      },
                    },
                    {
                      key: "moveTo",
                      label: t("transfer.moveTracksTo"),
                      allowed: movable.length,
                      onClick: () => {
                        setMultitrack({
                          items: { tracks: movable.map((tr) => tr.id) },
                          mode: "move",
                          projectId: null,
                        });
                      },
                    },
                  ],
                },
              ]}
            />
          )}
        </Stack>
      )}
      <MultitrackDialog
        request={multitrack}
        onClose={() => {
          setMultitrack(null);
        }}
        onDone={selection.exit}
      />
      <RemoveLosslessDialog
        items={removeItems}
        onClose={() => {
          setRemoveItems(null);
        }}
        onDone={selection.exit}
      />
      {pending && (
        <MatchDialog
          proposals={pending.proposals}
          tracks={list}
          onClose={() => {
            setPending(null);
          }}
          onConfirm={(result) => {
            pending.files.forEach((file, i) => {
              const p = result[i];
              if (p) upload(file, p);
            });
            setPending(null);
          }}
        />
      )}
    </Section>
  );
}
