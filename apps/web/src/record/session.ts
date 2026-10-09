import { updateTrackVersion } from "@bandroom/shared";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { projectKeys, songKeys } from "../features/library/queries";
import { offlineDb } from "../offline/controller";
import { isOnline, onReconnect } from "../offline/online";
import { startUpload, uploadFailure } from "../upload/startUpload";
import { useUploadErrorText } from "../upload/UploadRow";
import { useUploads } from "../upload/uploadStore";
import { recordingSupported, removeTakeFiles, takeFile } from "./opfs";
import { recoverTakesOnDevice, setWriterListener } from "./takeWriterClient";
import { onWriterEvent, setTakesDeps } from "./takes";

/**
 * Connects the takes service to the app (SPEC §9): OPFS, uploads, the API, the network state and
 * the user-visible notices. Call it before `startTakes`.
 */
export function useTakesDeps(): void {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const errorText = useUploadErrorText();
  // The latest translations for the notices (the service lives longer than a render).
  const ui = useRef({ t, errorText });
  useEffect(() => {
    ui.current = { t, errorText };
  });
  useEffect(() => {
    setTakesDeps({
      db: offlineDb,
      file: takeFile,
      remove: removeTakeFiles,
      upload: (file, target, scope) =>
        startUpload(file, target, scope).catch((err: unknown) => {
          // The take's own row shows the failure (Retry, Discard): no second, upload row.
          const store = useUploads.getState();
          for (const i of store.items) if (i.target === target) store.remove(i.id);
          throw err;
        }),
      setLabel: async (id, label) => {
        await api(updateTrackVersion, { params: { id }, body: { label } });
      },
      isOnline,
      recover: (userId) =>
        recordingSupported() ? recoverTakesOnDevice(userId) : Promise.resolve([]),
      onReconnect,
      now: () => Date.now(),
      failureCode: (err) => uploadFailure(err)?.code ?? null,
      onUploaded: (take, result) => {
        const songId = result.songId ?? take.songId;
        if (songId) void qc.invalidateQueries({ queryKey: songKeys.tracks(songId) });
        void qc.invalidateQueries({ queryKey: projectKeys.songs(take.projectId) });
        notifications.show({
          color: "green",
          message: ui.current.t("record.uploaded", { title: take.title }),
        });
      },
      onFailed: (take, code) => {
        notifications.show({
          color: "red",
          autoClose: 10_000,
          title: ui.current.t("record.uploadFailed", { title: take.title }),
          message:
            code === "TAKE_MISSING"
              ? ui.current.t("record.takeMissing")
              : ui.current.errorText(code, null),
        });
      },
    });
    setWriterListener(onWriterEvent);
    return () => {
      setWriterListener(null);
    };
  }, [qc]);
}
