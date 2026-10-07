import type { Project } from "@bandroom/shared";
import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlayerPlayFilled } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { playQueue } from "../../player/listenEngine";
import { isPlayable } from "../../player/listenStore";
import { useProjectQueue } from "../../player/useProjectQueue";

/** "Play all" (SPEC §6.10, §11.2): the project's songs in Listen mode, lock-screen friendly. */
export function PlayAllButton({ project, songId }: { project: Project; songId?: string }) {
  const { t } = useTranslation();
  const queue = useProjectQueue(project);
  // Synchronous on purpose: play() must run inside the tap for iOS (see useProjectQueue).
  const play = () => {
    const items = queue.data;
    if (!items) return;
    if (!items.some(isPlayable)) {
      notifications.show({ color: "gray", message: t("listen.nothingToPlay") });
      return;
    }
    const index = songId
      ? Math.max(
          0,
          items.findIndex((q) => q.songId === songId),
        )
      : 0;
    playQueue(items, index);
  };
  return (
    <Button
      leftSection={<IconPlayerPlayFilled size={16} />}
      onClick={play}
      loading={queue.isPending}
      data-testid="play-all"
    >
      {t("listen.playAll")}
    </Button>
  );
}
