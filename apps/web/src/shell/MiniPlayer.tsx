import { ActionIcon, Group, Progress, Stack, Text, UnstyledButton } from "@mantine/core";
import {
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBackFilled,
  IconPlayerSkipForwardFilled,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import { ProjectImage } from "../components/ProjectImage";
import {
  closeSong,
  durationSec,
  hasNextSong,
  hasPreviousSong,
  nextSong,
  positionSec,
  previousSong,
  togglePlay,
  useRehearse,
} from "../rehearse/controller";

export const MINI_PLAYER_HEIGHT = 60;

/** Whether the mini-player shows: a song session is open and the user is not on its page. */
export function useMiniPlayerVisible(): boolean {
  const location = useLocation();
  const songId = useRehearse((s) => (s.open ? s.songId : null));
  return songId !== null && !location.pathname.endsWith(`/songs/${songId}`);
}

/** Song progress in percent, polled (the engine position is not React state). */
function useProgress(): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const tick = () => {
      const d = durationSec();
      setValue(d > 0 ? Math.min(100, (positionSec() / d) * 100) : 0);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => {
      clearInterval(id);
    };
  }, []);
  return value;
}

/**
 * Persistent mini-player (SPEC §6.10, §11.2) on the engine: the loaded song while the user is
 * elsewhere, with previous/play/next, close, and a link that opens the song.
 */
export function MiniPlayer({
  songPath = (songId) => `/songs/${songId}`,
}: {
  /** Where tapping the song goes (the public-link view has its own song pages). */
  songPath?: (songId: string) => string;
} = {}) {
  const { t } = useTranslation();
  const info = useRehearse((s) => (s.open ? s.info : null));
  const status = useRehearse((s) => s.status);
  const stopped = useRehearse((s) => s.lockHint || s.status === "interrupted");
  const hasNext = useRehearse((s) => hasNextSong(s));
  const hasPrev = useRehearse((s) => hasPreviousSong(s));
  const progress = useProgress();
  if (!info) return null;
  const playing = status === "playing" || status === "buffering";
  const busy = status === "loading" || status === "idle";
  return (
    <Stack
      gap={0}
      h={MINI_PLAYER_HEIGHT}
      data-testid="mini-player"
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
    >
      <Progress value={progress} size={2} radius={0} aria-hidden />
      <Group justify="space-between" wrap="nowrap" px="xs" gap={4} style={{ flex: 1 }}>
        <UnstyledButton
          component={Link}
          to={songPath(info.songId)}
          style={{ flex: 1, minWidth: 0 }}
          aria-label={t("listen.openSong", { title: info.title })}
          data-testid="mini-open"
        >
          <Group gap="sm" wrap="nowrap">
            <ProjectImage
              name={info.projectName}
              color="violet"
              imageHash={info.imageHash}
              size={40}
              radius="var(--mantine-radius-sm)"
            />
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="sm" fw={600} truncate data-testid="mini-title">
                {info.title}
              </Text>
              {stopped && !playing ? (
                <Text size="xs" c="orange" truncate data-testid="mini-interrupted">
                  {t("listen.interrupted")}
                </Text>
              ) : (
                <Text size="xs" c="dimmed" truncate>
                  {info.projectName}
                </Text>
              )}
            </Stack>
          </Group>
        </UnstyledButton>
        <Group gap={0} wrap="nowrap">
          {hasPrev && (
            <ActionIcon
              size={44}
              variant="subtle"
              color="gray"
              onClick={previousSong}
              aria-label={t("listen.previous")}
              data-testid="mini-prev"
            >
              <IconPlayerSkipBackFilled size={20} />
            </ActionIcon>
          )}
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            onClick={togglePlay}
            loading={busy}
            aria-label={playing ? t("listen.pause") : t("listen.play")}
            data-testid="mini-play"
          >
            {playing ? <IconPlayerPauseFilled size={22} /> : <IconPlayerPlayFilled size={22} />}
          </ActionIcon>
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            onClick={nextSong}
            disabled={!hasNext}
            aria-label={t("listen.next")}
            data-testid="mini-next"
          >
            <IconPlayerSkipForwardFilled size={20} />
          </ActionIcon>
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            onClick={closeSong}
            aria-label={t("listen.stop")}
            data-testid="mini-close"
          >
            <IconX size={18} />
          </ActionIcon>
        </Group>
      </Group>
    </Stack>
  );
}
