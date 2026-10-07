import { notifications } from "@mantine/notifications";
import type { TFunction } from "i18next";
import { dropSongs } from "../rehearse/controller";
import type { GoneSongs } from "./queue";

/**
 * Deleted songs leave the engine queue (SPEC §6.10); when the loaded song was deleted, playback
 * stops and a toast says why. Used by the delete actions and by SSE deletes of others.
 */
export function dropDeletedFromQueue(t: TFunction, gone: GoneSongs): void {
  if (dropSongs(gone) !== "stopped") return;
  notifications.show({
    id: "listen-gone",
    color: "gray",
    message: gone.projectId !== undefined ? t("listen.projectDeleted") : t("listen.songDeleted"),
  });
}
