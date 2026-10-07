import { deleteTrack, retryTrackVersion, type Song, type Track } from "@bandroom/shared";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ActionIcon,
  Box,
  Button,
  Center,
  Checkbox,
  Group,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconChevronDown, IconGripVertical } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { useCurrentUser } from "../../auth/session";
import { isProbablyAudio } from "../../lib/media";
import { startUpload } from "../../upload/startUpload";
import { useUploadErrorToast } from "../../upload/UploadRow";
import { songKeys } from "../library/queries";
import { trackPermissions } from "./model";
import { TrackEditModal } from "./TrackEditModal";
import { TrackMenu } from "./TrackMenu";
import { VersionStackModal } from "./VersionStackModal";
import { VersionStatus } from "./VersionStatus";
import { useLongPress } from "../../selection/useLongPress";

/** A track row's part in the list's selection (SPEC §26.1). */
export interface TrackRowSelection {
  selecting: boolean;
  selected: boolean;
  showCheckbox: boolean;
  onToggle: () => void;
}

/**
 * One track: name, version button, status/waveform, actions; drop a file for a new version.
 * `draggable`: a handle reorders the track (inside the list's sortable context, SPEC §28.5).
 */
export function TrackRow({
  track,
  song,
  selection,
  draggable = false,
}: {
  track: Track;
  song: Song;
  selection?: TrackRowSelection | undefined;
  draggable?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const user = useCurrentUser();
  const qc = useQueryClient();
  const apiError = useApiError();
  const uploadErrorToast = useUploadErrorToast();
  const v = track.current;
  const refresh = () => qc.invalidateQueries({ queryKey: songKeys.tracks(song.id) });
  const onError = (err: unknown) => notifications.show({ color: "red", message: apiError(err) });

  const del = useMutation({
    mutationFn: () => api(deleteTrack, { params: { id: track.id } }),
    onSuccess: refresh,
    onError,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api(retryTrackVersion, { params: { id } }),
    onSuccess: refresh,
    onError,
  });
  const { canDelete, canEditTrack, canRetry, canUpload } = trackPermissions(song, track, user.id);
  const [stackOpen, setStackOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const selecting = selection?.selecting === true;
  // Only the handle starts a drag, so long-press selection and file drops keep working.
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: track.id, disabled: !draggable });
  const longPress = useLongPress(
    () => selection?.onToggle(),
    selection !== undefined && !selecting,
  );

  const uploadVersion = (file: File | null) => {
    if (!file) return;
    startUpload(
      file,
      { type: "newVersion", trackId: track.id },
      { songId: song.id, projectId: song.project.id },
    )
      .then(refresh)
      .catch((err: unknown) => {
        uploadErrorToast(err, file.name);
      });
  };

  return (
    <Paper
      ref={setNodeRef}
      withBorder
      radius="md"
      p={0}
      data-testid="track-row"
      data-track={track.name}
      data-track-id={track.id}
      data-selected={selection?.selected || undefined}
      bg={selection?.selected ? "var(--mantine-primary-color-light)" : undefined}
      {...longPress}
      onClickCapture={(e) => {
        longPress.onClickCapture(e);
        if (!selecting || e.isPropagationStopped()) return;
        // In selection mode a tap anywhere on the row (buttons included) selects it.
        e.preventDefault();
        e.stopPropagation();
        selection.onToggle();
      }}
      style={{
        cursor: selecting ? "pointer" : undefined,
        WebkitTouchCallout: "none",
        overflow: "hidden",
        outline: dragOver ? "2px dashed var(--mantine-primary-color-filled)" : undefined,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
        position: "relative",
        zIndex: isDragging ? 1 : undefined,
      }}
      // Dropping a file onto a track row adds a new version (SPEC §5.1).
      onDragOver={(e) => {
        if (!canUpload || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        setDragOver(true);
      }}
      onDragLeave={() => {
        setDragOver(false);
      }}
      onDrop={(e) => {
        if (!canUpload) return;
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        const file = [...e.dataTransfer.files].find(isProbablyAudio);
        if (file) uploadVersion(file);
      }}
    >
      <Group gap={0} wrap="nowrap" align="stretch">
        <Box w={6} bg={`${track.color}.6`} aria-hidden />
        {draggable && (
          <Center style={{ flex: "none" }}>
            <ActionIcon
              ref={setActivatorNodeRef}
              variant="subtle"
              color="gray"
              size={44}
              aria-label={t("tracks.dragHandle", { name: track.name })}
              style={{ cursor: "grab", touchAction: "none" }}
              data-testid="track-drag-handle"
              {...attributes}
              {...listeners}
            >
              <IconGripVertical size={18} />
            </ActionIcon>
          </Center>
        )}
        {selection?.showCheckbox && (
          <Center w={44} style={{ flex: "none" }}>
            <Checkbox
              checked={selection.selected}
              onChange={selection.onToggle}
              aria-label={t("selection.selectItem", { name: track.name })}
              data-testid="track-row-check"
            />
          </Center>
        )}
        <Stack gap={6} p="sm" style={{ flex: 1, minWidth: 0 }}>
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: "1 1 auto" }}>
              <Text fw={600} truncate data-testid="track-name">
                {track.name}
              </Text>
              {v && (
                <Button
                  size="compact-xs"
                  variant="light"
                  color="gray"
                  rightSection={<IconChevronDown size={12} />}
                  title={v.label || undefined}
                  onClick={() => {
                    setStackOpen(true);
                  }}
                  aria-label={t("versions.open", { track: track.name })}
                  data-testid="version-button"
                  style={{ flex: "none" }}
                >
                  {t("tracks.versionBadge", { number: v.number })}
                  {track.versionCount > 1 ? ` / ${String(track.versionCount)}` : ""}
                </Button>
              )}
            </Group>
            {!selecting && (
              <TrackMenu
                version={v}
                canDelete={canDelete}
                canRetry={canRetry && v?.status === "failed"}
                canUpload={canUpload}
                onDelete={() => {
                  del.mutate();
                }}
                onRetry={() => {
                  if (v) retry.mutate(v.id);
                }}
                onUpload={uploadVersion}
                canEditTrack={canEditTrack}
                onEditTrack={() => {
                  setEditOpen(true);
                }}
              />
            )}
          </Group>
          {v && (
            <VersionStatus
              version={v}
              color={track.color}
              locale={i18n.resolvedLanguage ?? "en"}
              trackBytes={track.versionCount > 1 ? track.bytes : undefined}
            />
          )}
        </Stack>
      </Group>
      {stackOpen && (
        <VersionStackModal
          track={track}
          song={song}
          opened
          onClose={() => {
            setStackOpen(false);
          }}
        />
      )}
      {editOpen && (
        <TrackEditModal
          track={track}
          onClose={() => {
            setEditOpen(false);
          }}
        />
      )}
    </Paper>
  );
}
