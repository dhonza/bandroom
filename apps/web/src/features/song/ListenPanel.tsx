import { getSongListen, type Song, type Track } from "@bandroom/shared";
import { ActionIcon, Badge, Group, Loader, Menu, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerTrackNextFilled,
  IconPlayerTrackPrevFilled,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { Section } from "../../components/Section";
import { formatClock } from "../../player/format";
import {
  LoopButton,
  MarkerEditor,
  MarkerToolbar,
  SectionChips,
  SectionReadout,
  SelectionBar,
  TimelineMenu,
  useTimelineMarkers,
} from "../../markers/SongMarkers";
import { ShortcutHelp, useSongShortcuts } from "../../markers/shortcuts";
import { SongComments } from "../../comments/CommentsPanel";
import { goNext, goPrev, playPause, registerPlayer } from "../../markers/store";
import { currentTime, seek, setListenLoop, togglePlay } from "../../player/listenEngine";
import { useListen } from "../../player/listenStore";
import { useProjectQueue } from "../../player/useProjectQueue";
import { PHONE_QUERY } from "../../shell/mediaQueries";
import { BarBeatText } from "../../tempo/readout";
import { Timeline } from "../../timeline/Timeline";
import { useLaneHeight } from "../../timeline/laneHeight";
import { usePeaks } from "../../timeline/usePeaks";
import { songKeys } from "../library/queries";
import { ListenOptions } from "./ListenOptions";
import { MixerButton } from "./MixerButton";
import { startMix } from "./playerHandoff";
import type { MixerToggle } from "./useMixerToggle";

/**
 * The song player with the Mixer closed (SPEC §6.10, §11.3; DECISIONS 2026-09-29): the mix through
 * `<audio>`, the mix's waveform (one lane: per-track lanes say nothing while the mix plays,
 * DECISIONS 2026-10-07) with tap-to-seek, a big play button and the position readout.
 * Playing starts the project queue at this song so lock-screen next/previous move between songs.
 * Without `mixer` (mix-only links, songs without tracks) there is no Mixer button.
 */
export function ListenPanel({
  song,
  tracks,
  mixer,
}: {
  song: Song;
  tracks: Track[];
  mixer?: MixerToggle | undefined;
}) {
  const { t } = useTranslation();
  const queue = useProjectQueue(song.project);
  const isPhone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const listen = useQuery({
    queryKey: songKeys.listen(song.id),
    queryFn: ({ signal }) => api(getSongListen, { params: { id: song.id } }, { signal }),
  });
  const isCurrent = useListen((s) => s.queue[s.index]?.songId === song.id);
  const status = useListen((s) => (s.queue[s.index]?.songId === song.id ? s.status : "idle"));
  const position = useListen((s) => (s.queue[s.index]?.songId === song.id ? s.position : 0));

  const src = listen.data?.listen ?? null;
  const ready = src?.status === "ready" && src.opus !== null;
  const readyTracks = tracks.filter(
    (tr) => tr.current?.status === "ready" && tr.current.variants.peaks,
  );
  const duration =
    src?.durationSec ??
    Math.max(
      0,
      ...readyTracks.map(
        (tr) => (tr.current?.media?.durationSec ?? 0) + (tr.current?.offsetSamples ?? 0) / 48_000,
      ),
    );

  const pyramids = usePeaks([src?.peaks?.hash ?? null]);
  const lanes = useMemo(
    () => [{ id: "mix", color: song.project.color, offsetSamples: 0, peaks: pyramids[0] ?? null }],
    [pyramids, song.project.color],
  );

  // Synchronous on purpose: play() must run inside the tap for iOS (see useProjectQueue).
  const start = (startAt: number, autoplay: boolean) => {
    if (src) startMix(song, src, queue.data, startAt, autoplay);
  };

  const onPlay = () => {
    if (isCurrent) togglePlay();
    else start(0, true);
  };
  const onSeek = (sec: number) => {
    if (isCurrent) seek(sec);
    else start(sec, false);
  };
  const getPosition = useCallback(
    () =>
      useListen.getState().queue[useListen.getState().index]?.songId === song.id
        ? currentTime()
        : 0,
    [song.id],
  );

  // Vertical zoom (SPEC §25.9), per view; these are the defaults.
  const [laneHeight, setLaneHeight] = useLaneHeight("listen.summed", 56);
  const timelineMarkers = useTimelineMarkers(song, duration, lanes.length, laneHeight);
  // K / C (click, count-in) open the Mixer, where click and count-in live.
  const mixerRef = useRef(mixer);
  useEffect(() => {
    mixerRef.current = mixer;
  });
  const openForClick = useCallback(() => {
    mixerRef.current?.turnOn();
    return true;
  }, []);
  const hasMixer = mixer !== undefined;
  useSongShortcuts(song, hasMixer ? { onCountIn: openForClick, onClick: openForClick } : {});

  // The page's transport actions (shortcuts, chips, prev/next) drive this player (SPEC §6.10).
  const live = useRef({ onPlay, onSeek, isCurrent, status, duration });
  useEffect(() => {
    live.current = { onPlay, onSeek, isCurrent, status, duration };
  });
  useEffect(() => {
    const unregister = registerPlayer({
      mode: "listen",
      position: getPosition,
      duration: () => live.current.duration,
      seek: (sec) => {
        live.current.onSeek(sec);
      },
      setLoop: (range) => {
        setListenLoop(song.id, range);
      },
      togglePlay: () => {
        live.current.onPlay();
      },
      isPlaying: () => live.current.isCurrent && live.current.status === "playing",
    });
    return () => {
      unregister();
      setListenLoop(song.id, null);
    };
  }, [song.id, getPosition]);

  if (listen.isPending) return <Loader size="sm" />;
  if (!src && readyTracks.length === 0) return null;

  return (
    <Section title={t("mixer.playerTitle")} testId="listen-panel">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap={4} wrap="nowrap">
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            aria-label={t("markers.prev")}
            onClick={goPrev}
            data-testid="go-prev"
          >
            <IconPlayerTrackPrevFilled size={20} />
          </ActionIcon>
          <ActionIcon
            size={56}
            radius="xl"
            variant="filled"
            disabled={!ready}
            onClick={playPause}
            aria-label={status === "playing" ? t("listen.pause") : t("listen.play")}
            data-testid="listen-play"
          >
            {status === "playing" ? (
              <IconPlayerPauseFilled size={26} />
            ) : (
              <IconPlayerPlayFilled size={26} />
            )}
          </ActionIcon>
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            aria-label={t("markers.next")}
            onClick={goNext}
            data-testid="go-next"
          >
            <IconPlayerTrackNextFilled size={20} />
          </ActionIcon>
          <LoopButton
            {...(mixer && {
              options: (
                <Menu.Item onClick={openForClick} data-testid="loop-open-mixer">
                  {t("click.listenHint")}
                </Menu.Item>
              ),
            })}
          />
          <Stack gap={0}>
            <Group gap="xs" wrap="nowrap">
              <Text size="xl" fw={700} className="tabular-nums" data-testid="listen-position">
                {formatClock(position)}
              </Text>
              <BarBeatText size="xl" c="dimmed" />
            </Group>
            <Text size="xs" c="dimmed" className="tabular-nums">
              {formatClock(duration, false)}
              {src?.isAutoMix ? ` · ${t("listen.autoMix")}` : ""}
            </Text>
          </Stack>
        </Group>
        {!ready && (
          <Badge variant="light" color="gray">
            {src ? t("listen.preparing") : t("listen.noMix")}
          </Badge>
        )}
        {mixer && (
          <Group gap="sm" wrap="nowrap" style={isPhone ? { flex: "1 1 100%" } : undefined}>
            <MixerButton
              open={false}
              onClick={() => {
                mixer.turnOn();
              }}
            />
          </Group>
        )}
      </Group>
      {duration > 0 && (
        <Timeline
          lanes={lanes}
          durationSec={duration}
          getPosition={getPosition}
          playing={status === "playing"}
          onSeek={onSeek}
          laneHeight={laneHeight}
          onLaneHeight={setLaneHeight}
          {...timelineMarkers.props}
        />
      )}
      <SectionReadout />
      <SelectionBar song={song} />
      <SectionChips />
      <MarkerToolbar song={song} />
      <SongComments song={song} />
      <TimelineMenu
        song={song}
        menu={timelineMarkers.menu}
        onClose={timelineMarkers.closeMenu}
        durationSec={duration}
      />
      <MarkerEditor song={song} />
      <ShortcutHelp />
      <Group justify="space-between" wrap="nowrap" align="center">
        <Text size="xs" c="dimmed">
          {mixer ? t("listen.rehearseHint") : ""}
        </Text>
        <ListenOptions />
      </Group>
    </Section>
  );
}
