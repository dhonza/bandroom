import { ActionIcon, Group, Progress, Stack, Text, UnstyledButton } from "@mantine/core";
import {
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipForwardFilled,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import { ProjectImage } from "../components/ProjectImage";
import { next, stop, togglePlay } from "../player/listenEngine";
import { useListen } from "../player/listenStore";

export const MINI_PLAYER_HEIGHT = 60;

/** Whether the mini-player shows: something queued and not on that song's own page. */
export function useMiniPlayerVisible(): boolean {
  const location = useLocation();
  const songId = useListen((s) => s.queue[s.index]?.songId ?? null);
  return songId !== null && !location.pathname.endsWith(`/songs/${songId}`);
}

/** Persistent mini-player (SPEC §11.2) when a song is loaded and the user navigates away. */
export function MiniPlayer({
  songPath = (songId) => `/songs/${songId}`,
}: {
  /** Where tapping the song goes (the public-link view has its own song pages). */
  songPath?: (songId: string) => string;
} = {}) {
  const { t } = useTranslation();
  const entry = useListen((s) => s.queue[s.index] ?? null);
  const status = useListen((s) => s.status);
  const progress = useListen((s) => (s.duration > 0 ? (s.position / s.duration) * 100 : 0));
  const hasNext = useListen((s) => s.index < s.queue.length - 1 || s.repeat === "all");
  if (!entry) return null;
  return (
    <Stack
      gap={0}
      h={MINI_PLAYER_HEIGHT}
      data-testid="mini-player"
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
    >
      <Progress value={progress} size={2} radius={0} aria-hidden />
      <Group justify="space-between" wrap="nowrap" px="xs" style={{ flex: 1 }}>
        <UnstyledButton
          component={Link}
          to={songPath(entry.songId)}
          style={{ flex: 1, minWidth: 0 }}
          aria-label={t("listen.openSong", { title: entry.title })}
        >
          <Group gap="sm" wrap="nowrap">
            <ProjectImage
              name={entry.projectName}
              color="violet"
              imageHash={entry.imageHash}
              size={40}
              radius="var(--mantine-radius-sm)"
            />
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="sm" fw={600} truncate>
                {entry.title}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {entry.projectName}
              </Text>
            </Stack>
          </Group>
        </UnstyledButton>
        <Group gap={0} wrap="nowrap">
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            onClick={togglePlay}
            aria-label={status === "playing" ? t("listen.pause") : t("listen.play")}
            data-testid="mini-play"
          >
            {status === "playing" ? (
              <IconPlayerPauseFilled size={22} />
            ) : (
              <IconPlayerPlayFilled size={22} />
            )}
          </ActionIcon>
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            onClick={next}
            disabled={!hasNext}
            aria-label={t("listen.next")}
          >
            <IconPlayerSkipForwardFilled size={20} />
          </ActionIcon>
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            onClick={stop}
            aria-label={t("listen.stop")}
          >
            <IconX size={18} />
          </ActionIcon>
        </Group>
      </Group>
    </Stack>
  );
}
