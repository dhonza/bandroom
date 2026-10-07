import { notifications } from "@mantine/notifications";
import type { TFunction } from "i18next";
import { dropFromQueue, type GoneSongs } from "./listenEngine";

/**
 * Deleted songs leave the Listen queue (SPEC §6.10); when the playing song was deleted, the mini
 * player stops and a toast says why. Used by the delete actions and by SSE deletes of others.
 */
export function dropDeletedFromQueue(t: TFunction, gone: GoneSongs): void {
  if (dropFromQueue(gone) !== "stopped") return;
  notifications.show({
    id: "listen-gone",
    color: "gray",
    message: gone.projectId !== undefined ? t("listen.projectDeleted") : t("listen.songDeleted"),
  });
}
