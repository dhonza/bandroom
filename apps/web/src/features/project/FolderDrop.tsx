import { createSong, type Project } from "@bandroom/shared";
import { Group, Stack, Text } from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { notifications } from "@mantine/notifications";
import { IconFolderPlus } from "@tabler/icons-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useOnline } from "../../offline/online";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { groupByFolder, isProbablyAudio, trackNamesFromFiles } from "../../lib/media";
import { startUpload } from "../../upload/startUpload";
import { useUploads } from "../../upload/uploadStore";
import {
  isDocumentUpload,
  UploadRow,
  useUploadErrorText,
  useUploadErrorToast,
} from "../../upload/UploadRow";
import { useInvalidateContent } from "../library/queries";

type FileWithPath = File & { path?: string };

/**
 * Dropping folders onto a project (SPEC §5.1): each folder becomes a song named after it, with one
 * track per audio file. A single loose file becomes a one-track song named after the file. The uploads it
 * starts are listed below the drop zone; failures are reported per song or file.
 */
export function FolderDrop({ project }: { project: Project }) {
  const { t } = useTranslation();
  const online = useOnline();
  const invalidate = useInvalidateContent();
  const apiError = useApiError();
  const errorText = useUploadErrorText();
  const uploadErrorToast = useUploadErrorToast();
  // Select the stable array, filter outside the selector (a new array per call would loop).
  const allUploads = useUploads((s) => s.items);
  const uploads = useMemo(
    () =>
      allUploads.filter(
        (i) =>
          i.projectId === project.id &&
          i.songId !== null &&
          i.status !== "done" &&
          !isDocumentUpload(i),
      ),
    [allUploads, project.id],
  );

  const onDrop = async (dropped: FileWithPath[]) => {
    const files = dropped.filter(isProbablyAudio);
    if (files.length < dropped.length)
      notifications.show({ color: "yellow", message: t("tracks.skippedNonAudio") });
    const groups = groupByFolder(files);
    let created = 0;
    for (const g of groups) {
      const groupFiles = g.indexes.flatMap((i) => (files[i] ? [files[i]] : []));
      const songs = g.folder
        ? [{ title: g.folder, files: groupFiles, loose: false }]
        : groupFiles.map((f) => ({
            title: f.name.replace(/\.[^.]+$/, ""),
            files: [f],
            loose: true,
          }));
      for (const s of songs) {
        let songId: string;
        try {
          const { song } = await api(createSong, {
            params: { id: project.id },
            body: { title: s.title.slice(0, 200) },
          });
          songId = song.id;
        } catch (err) {
          notifications.show({ color: "red", title: s.title, message: apiError(err) });
          continue;
        }
        created++;
        // A loose file is a one-track song; its track is named after the song (SPEC §5.1, M21).
        const names = s.loose
          ? [s.title.slice(0, 120)]
          : trackNamesFromFiles(s.files.map((f) => f.name));
        s.files.forEach((file, i) => {
          startUpload(
            file,
            { type: "newTrack", songId, name: names[i] ?? file.name },
            { songId, projectId: project.id },
          )
            .then(invalidate)
            .catch((err: unknown) => {
              uploadErrorToast(err, file.name);
            });
        });
      }
    }
    if (created > 0)
      notifications.show({
        color: "teal",
        message: t("songs.createdFromFolder", { count: created }),
      });
  };

  const handleDrop = (dropped: FileWithPath[]) => {
    onDrop(dropped)
      .catch((err: unknown) => {
        notifications.show({ color: "red", message: apiError(err) });
      })
      .finally(invalidate);
  };

  return (
    <Stack gap="xs">
      <Dropzone
        onDrop={handleDrop}
        disabled={!online}
        multiple
        radius="md"
        p="md"
        data-testid="folder-dropzone"
        aria-label={t("songs.dropFolder")}
      >
        <Group justify="center" gap="md" style={{ pointerEvents: "none" }}>
          <IconFolderPlus size={26} aria-hidden />
          <Stack gap={0}>
            <Text fw={500}>{online ? t("songs.dropFolder") : t("offline.uploadNeedsNetwork")}</Text>
            <Text size="xs" c="dimmed">
              {t("songs.dropFolderHint")}
            </Text>
          </Stack>
        </Group>
      </Dropzone>
      {uploads.map((u) => (
        <UploadRow key={u.id} item={u} errorText={errorText} />
      ))}
    </Stack>
  );
}
