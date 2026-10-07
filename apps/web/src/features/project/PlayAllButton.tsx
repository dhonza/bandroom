import type { Project } from "@bandroom/shared";
import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlayerPlayFilled } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useProjectQueue, useQueueLoader } from "../../player/useProjectQueue";
import { startQueue } from "../../rehearse/controller";

/** "Play all" (SPEC §6.10, §11.2): the project's songs one after another on the engine. */
export function PlayAllButton({ project }: { project: Project }) {
  const { t } = useTranslation();
  const queue = useProjectQueue(project.id);
  const loader = useQueueLoader();
  // Synchronous on purpose: the audio is unlocked inside the tap for iOS (see useProjectQueue).
  const play = () => {
    const items = queue.data;
    if (!items) return;
    const source = {
      kind: "project" as const,
      projectId: project.id,
      projectName: project.name,
      imageHash: project.imageHash,
    };
    if (!startQueue(items, source, loader)) {
      notifications.show({ color: "gray", message: t("listen.nothingToPlay") });
    }
  };
  return (
    <Button
      h={44}
      leftSection={<IconPlayerPlayFilled size={16} />}
      onClick={play}
      loading={queue.isPending}
      data-testid="play-all"
    >
      {t("listen.playAll")}
    </Button>
  );
}
