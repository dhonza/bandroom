import {
  ActionIcon,
  Box,
  Divider,
  Drawer,
  Group,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import {
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBackFilled,
  IconPlayerSkipForwardFilled,
  IconPlaylist,
  IconRepeat,
  IconRepeatOff,
  IconRepeatOnce,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import { ProjectImage } from "../components/ProjectImage";
import { QueueDrawer, QueueList } from "../player/QueuePane";
import { SeekBar } from "../player/SeekBar";
import {
  closeSong,
  cycleRepeat,
  hasNextSong,
  isRecordingSongId,
  nextSong,
  previousSong,
  togglePlay,
  useRehearse,
  type SongInfo,
} from "../rehearse/controller";
import { PHONE_QUERY } from "./mediaQueries";

/** The desktop player bar's height (controls over the seek slider). */
export const MINI_PLAYER_HEIGHT = 76;
/** The phone's compact bar: one row under a thin seek slider. */
export const MINI_PLAYER_PHONE_HEIGHT = 66;

export function miniPlayerHeight(phone: boolean): number {
  return phone ? MINI_PLAYER_PHONE_HEIGHT : MINI_PLAYER_HEIGHT;
}

const MEDIA = { getInitialValueInEffect: false } as const;

/**
 * Whether the mini-player shows: a song session is open and the user is not on its page (another
 * song's page shows that song without taking the engine, SPEC §6.10).
 */
export function useMiniPlayerVisible(): boolean {
  const location = useLocation();
  const songId = useRehearse((s) => (s.open ? s.songId : null));
  return (
    songId !== null && !isRecordingSongId(songId) && !location.pathname.endsWith(`/songs/${songId}`)
  );
}

/** Play/pause state of the bar: a dormant queue (restored, added) shows Play, not loading. */
function usePlayState() {
  const status = useRehearse((s) => s.status);
  const dormant = useRehearse((s) => s.dormant);
  const playing = !dormant && (status === "playing" || status === "buffering");
  const busy = !dormant && (status === "loading" || status === "idle");
  return { playing, busy };
}

/**
 * Persistent player bar (SPEC §6.10, §11.2) on the engine, Samply-like: the project cover, the
 * project name over the song title (a link to the song), previous/play/next, repeat, a seek
 * slider with the times, the queue pane and ✕. Phones get a compact bar (cover, title,
 * play/pause, next, a thin slider) that opens a sheet with everything.
 */
export function MiniPlayer({
  songPath = (songId) => `/songs/${songId}`,
}: {
  /** Where tapping the song goes (the public-link view has its own song pages). */
  songPath?: (songId: string) => string;
} = {}) {
  const info = useRehearse((s) => (s.open ? s.info : null));
  const phone = useMediaQuery(PHONE_QUERY, false, MEDIA);
  if (!info) return null;
  return phone ? (
    <PhoneBar info={info} songPath={songPath} />
  ) : (
    <DesktopBar info={info} songPath={songPath} />
  );
}

interface BarProps {
  info: SongInfo;
  songPath: (songId: string) => string;
}

function DesktopBar({ info, songPath }: BarProps) {
  const { t } = useTranslation();
  const [queueOpen, queue] = useDisclosure(false);
  return (
    <Group
      h={MINI_PLAYER_HEIGHT}
      px="sm"
      gap="md"
      wrap="nowrap"
      data-testid="mini-player"
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
    >
      <Box style={{ flex: "1 1 0", minWidth: 0 }}>
        <SongLink info={info} songPath={songPath} cover={52} />
      </Box>
      <Stack gap={0} style={{ flex: "2 1 0", minWidth: 0, maxWidth: 640 }}>
        <Group gap={4} justify="center" wrap="nowrap">
          <RepeatButton />
          <Transport />
        </Group>
        <SeekBar />
      </Stack>
      <Group gap={0} wrap="nowrap" justify="flex-end" style={{ flex: "1 1 0" }}>
        <Tooltip label={t("listen.queue")}>
          <ActionIcon
            size={44}
            variant={queueOpen ? "light" : "subtle"}
            color={queueOpen ? undefined : "gray"}
            onClick={queue.toggle}
            aria-label={t("listen.queue")}
            aria-expanded={queueOpen}
            data-testid="mini-queue"
          >
            <IconPlaylist size={20} />
          </ActionIcon>
        </Tooltip>
        <CloseButton />
      </Group>
      <QueueDrawer opened={queueOpen} onClose={queue.close} />
    </Group>
  );
}

function PhoneBar({ info, songPath }: BarProps) {
  const { t } = useTranslation();
  const [sheetOpen, sheet] = useDisclosure(false);
  const { playing, busy } = usePlayState();
  const hasNext = useRehearse((s) => hasNextSong(s));
  return (
    <Box
      h={MINI_PLAYER_PHONE_HEIGHT}
      data-testid="mini-player"
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
    >
      <SeekBar thin />
      <Group h={52} px="xs" gap={4} wrap="nowrap">
        <UnstyledButton
          onClick={sheet.open}
          style={{ flex: 1, minWidth: 0 }}
          aria-label={t("listen.showPlayer", { title: info.title })}
          aria-haspopup="dialog"
          data-testid="mini-expand"
        >
          <SongText info={info} cover={40} />
        </UnstyledButton>
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
      </Group>
      <Drawer
        opened={sheetOpen}
        onClose={sheet.close}
        position="bottom"
        size="90%"
        title={t("listen.player")}
        closeButtonProps={{ "aria-label": t("common.close") }}
        styles={{
          body: { paddingBottom: "calc(var(--mantine-spacing-md) + env(safe-area-inset-bottom))" },
        }}
      >
        <Stack gap="md" data-testid="mini-sheet">
          <Box onClick={sheet.close}>
            <SongLink info={info} songPath={songPath} cover={64} />
          </Box>
          <SeekBar />
          <Group gap={4} justify="center" wrap="nowrap">
            <RepeatButton />
            <Transport />
            <CloseButton
              onClose={() => {
                sheet.close();
              }}
            />
          </Group>
          <Divider />
          <QueueList />
        </Stack>
      </Drawer>
    </Box>
  );
}

/** Cover, the project name in small caps and the song title (with the "interrupted" note). */
function SongText({ info, cover }: { info: SongInfo; cover: number }) {
  const { t } = useTranslation();
  const status = useRehearse((s) => s.status);
  const stopped = useRehearse((s) => s.lockHint || s.status === "interrupted");
  const playing = status === "playing" || status === "buffering";
  return (
    <Group gap="sm" wrap="nowrap">
      <ProjectImage
        name={info.projectName}
        color="violet"
        imageHash={info.imageHash}
        size={cover}
        radius="var(--mantine-radius-sm)"
      />
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Text
          size="xs"
          c="dimmed"
          fw={600}
          truncate
          style={{ fontVariantCaps: "all-small-caps", letterSpacing: "0.05em" }}
          data-testid="mini-project"
        >
          {info.projectName}
        </Text>
        <Text size="sm" fw={600} truncate data-testid="mini-title">
          {info.title}
        </Text>
        {stopped && !playing && (
          <Text size="xs" c="orange" truncate data-testid="mini-interrupted">
            {t("listen.interrupted")}
          </Text>
        )}
      </Stack>
    </Group>
  );
}

/** The song text as a link to the song's page. */
function SongLink({ info, songPath, cover }: BarProps & { cover: number }) {
  const { t } = useTranslation();
  return (
    <UnstyledButton
      component={Link}
      to={songPath(info.songId)}
      style={{ display: "block", minWidth: 0 }}
      aria-label={t("listen.openSong", { title: info.title })}
      data-testid="mini-open"
    >
      <SongText info={info} cover={cover} />
    </UnstyledButton>
  );
}

/** Previous, play/pause and next. */
function Transport() {
  const { t } = useTranslation();
  const { playing, busy } = usePlayState();
  const hasNext = useRehearse((s) => hasNextSong(s));
  return (
    <>
      <ActionIcon
        size={44}
        variant="subtle"
        color="gray"
        // Without a song before it, previous restarts this one.
        onClick={previousSong}
        aria-label={t("listen.previous")}
        data-testid="mini-prev"
      >
        <IconPlayerSkipBackFilled size={20} />
      </ActionIcon>
      <ActionIcon
        size={48}
        radius="xl"
        variant="filled"
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
    </>
  );
}

/** Repeat off → queue → song; the icon shows the mode. */
function RepeatButton() {
  const { t } = useTranslation();
  const repeat = useRehearse((s) => s.repeat);
  const label =
    repeat === "one"
      ? t("listen.repeatOne")
      : repeat === "all"
        ? t("listen.repeatAll")
        : t("listen.repeatOff");
  return (
    <Tooltip label={label}>
      <ActionIcon
        size={44}
        variant={repeat === "off" ? "subtle" : "light"}
        color={repeat === "off" ? "gray" : undefined}
        onClick={cycleRepeat}
        aria-label={label}
        data-testid="mini-repeat"
        data-mode={repeat}
      >
        {repeat === "one" ? (
          <IconRepeatOnce size={20} />
        ) : repeat === "all" ? (
          <IconRepeat size={20} />
        ) : (
          <IconRepeatOff size={20} />
        )}
      </ActionIcon>
    </Tooltip>
  );
}

function CloseButton({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  return (
    <ActionIcon
      size={44}
      variant="subtle"
      color="gray"
      onClick={() => {
        onClose?.();
        closeSong();
      }}
      aria-label={t("listen.stop")}
      data-testid="mini-close"
    >
      <IconX size={18} />
    </ActionIcon>
  );
}
