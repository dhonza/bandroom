import {
  dbToGain,
  getSongListen,
  getSongMixer,
  listTrackVersions,
  type Song,
  type Track,
  type TrackVersion,
} from "@bandroom/shared";
import { Alert, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useOffline } from "../offline/controller";
import { pendingMixer } from "../offline/pending";
import { useOptionalUser } from "../auth/session";
import { isLinkMode, loadLocalMix } from "../links/linkMode";
import { Section } from "../components/Section";
import { songKeys } from "../features/library/queries";
import { MixerButton } from "../features/song/MixerButton";
import type { MixerToggle } from "../features/song/useMixerToggle";
import { COARSE_POINTER_QUERY, PHONE_QUERY, WIDE_QUERY } from "../shell/mediaQueries";
import { Timeline } from "../timeline/Timeline";
import { MIN_LANE_H, useLaneHeight } from "../timeline/laneHeight";
import { usePeaks } from "../timeline/usePeaks";
import {
  MarkerEditor,
  MarkerToolbar,
  SectionChips,
  SectionReadout,
  SelectionBar,
  TimelineMenu,
  useTimelineMarkers,
} from "../markers/SongMarkers";
import { ShortcutHelp, useSongShortcuts } from "../markers/shortcuts";
import { SongComments } from "../comments/CommentsPanel";
import { registerPlayer } from "../markers/store";
import {
  closeSong,
  dismissLockHint,
  durationSec,
  isPlaying,
  openSong,
  positionSec,
  seekSec,
  selectTrack,
  setLoopSec,
  setTrack,
  togglePlay,
  toggleAB,
  toggleClick,
  toggleCountIn,
  useRehearse,
} from "./controller";
import { CountInCountdown } from "./ClickControls";
import { BarBeatText } from "../tempo/readout";
import { touchMinLaneHeight } from "./headerTier";
import { MixerTools } from "./MixerTools";
import { dimmedTrackIds } from "./model";
import { TrackStrip } from "./TrackStrip";
import { PositionText, Transport, TransportState } from "./Transport";

const HEADER_W = 320;
/** Phones: name above M/S (DECISIONS 2026-10-07). */
const HEADER_W_NARROW = 116;

/**
 * The song player with the Mixer open (SPEC §6, §11.3; DECISIONS 2026-09-29): the multitrack
 * engine with the personal mixer, version A/B and the transport. `mixer` switches back to the mix.
 * Every screen shows one lane per track with its header; phones get a narrow header (DECISIONS
 * 2026-10-06). With `defaultMix` it is the closed Mixer of a song whose mix is not ready yet
 * (SPEC §25.5): the tracks play with the default mix, shown as one mix lane without controls.
 */
export function RehearsePanel({
  song,
  tracks,
  mixer: toggle,
  defaultMix = false,
}: {
  song: Song;
  tracks: Track[];
  mixer?: MixerToggle | undefined;
  defaultMix?: boolean;
}) {
  const { t } = useTranslation();
  const user = useOptionalUser();
  const instrumentTag = user?.instrumentTag ?? "";
  const wide = useMediaQuery(WIDE_QUERY, false, { getInitialValueInEffect: false });
  const isPhone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const coarse = useMediaQuery(COARSE_POINTER_QUERY, false, { getInitialValueInEffect: false });
  const mixerQuery = useQuery({
    queryKey: songKeys.mixer(song.id),
    // Link visitors have no account: their mix is kept in this browser.
    queryFn: ({ signal }) =>
      isLinkMode()
        ? Promise.resolve({ state: loadLocalMix(song.id), snapshots: [] })
        : api(getSongMixer, { params: { id: song.id } }, { signal }).then((r) => ({
            ...r,
            // A mix changed offline and not sent yet wins (SPEC §13 outbox).
            state: pendingMixer(useOffline.getState().outbox, song.id) ?? r.state,
          })),
  });
  // The mix's peaks for the default-mix player (shared with the mix player's query).
  const listen = useQuery({
    queryKey: songKeys.listen(song.id),
    queryFn: ({ signal }) => api(getSongListen, { params: { id: song.id } }, { signal }),
  });

  // Personal listened versions that are not the current one need their version data.
  const saved = mixerQuery.data?.state ?? null;
  const needVersions = tracks.filter((tr) => {
    const id = saved?.tracks[tr.id]?.listenedVersionId;
    return id && id !== tr.current?.id;
  });
  const versionQueries = useQueries({
    queries: needVersions.map((tr) => ({
      queryKey: songKeys.versions(song.id, tr.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api(listTrackVersions, { params: { id: tr.id } }, { signal }),
    })),
  });
  const versionsReady = versionQueries.every((q) => !q.isPending);
  const listened = useMemo(() => {
    const out: Record<string, TrackVersion | undefined> = {};
    needVersions.forEach((tr, i) => {
      const id = saved?.tracks[tr.id]?.listenedVersionId;
      out[tr.id] = versionQueries[i]?.data?.versions.find((v) => v.id === id);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute when the data changes
  }, [saved, versionsReady, tracks]);

  const ready = !mixerQuery.isPending && versionsReady;
  useEffect(() => {
    if (!ready) return;
    void openSong(
      song.id,
      tracks,
      saved,
      listened,
      instrumentTag,
      defaultMix ? "default" : "mixer",
    );
  }, [ready, song.id, tracks, saved, listened, instrumentTag, defaultMix]);
  useEffect(() => closeSong, [song.id]);

  useEffect(
    () =>
      registerPlayer({
        mode: "rehearse",
        position: positionSec,
        duration: durationSec,
        seek: seekSec,
        setLoop: setLoopSec,
        togglePlay,
        isPlaying,
      }),
    [],
  );
  useRehearseKeys(song, defaultMix);

  const playing = useRehearse((s) => s.tracks);
  // Only mute/solo matter to the lanes: a fader move must not rebuild them (and redraw the
  // waveforms).
  const dimmedKey = useRehearse((s) => dimmedTrackIds(s.mix).join("\n"));
  const status = useRehearse((s) => s.status);
  const lengthSec = useRehearse((s) => s.lengthSec);
  const lockHint = useRehearse((s) => s.lockHint);

  // The closed Mixer shows only what plays: the mix (DECISIONS 2026-10-07).
  const summed = defaultMix;
  const hashes = summed
    ? [listen.data?.listen?.peaks?.hash ?? null]
    : playing.map((p) => p.version.variants.peaks?.hash ?? null);
  const pyramids = usePeaks(hashes);
  const lanes = useMemo(
    () =>
      summed
        ? [{ id: "mix", color: song.project.color, offsetSamples: 0, peaks: pyramids[0] ?? null }]
        : playing.map((p, i) => ({
            id: p.track.id,
            color: p.track.color,
            offsetSamples: p.version.offsetSamples,
            peaks: pyramids[i] ?? null,
            dimmed: dimmedKey.split("\n").includes(p.track.id),
            // The version's gain shows in the waveform; the personal fader does not (§25.6).
            scale: dbToGain(p.version.gainDb),
            tint: true,
          })),
    [summed, playing, pyramids, dimmedKey, song.project.color],
  );
  const getPosition = useCallback(() => positionSec(), []);
  // Vertical zoom (SPEC §25.9), per view; these are the defaults.
  // On touch screens the lanes stay tall enough for 44 px M/S buttons.
  const minLaneHeight = !summed && coarse ? touchMinLaneHeight(isPhone) : MIN_LANE_H;
  const [laneHeight, setLaneHeight] = useLaneHeight(
    summed ? "listen.summed" : "rehearse",
    summed ? 56 : isPhone ? 66 : 100,
    minLaneHeight,
  );
  const timelineMarkers = useTimelineMarkers(song, lengthSec, lanes.length, laneHeight);

  // Mixer off: the mix continues from here (inside the tap, iOS).
  const canPlayMix = toggle?.mixPlayable === true;
  const playMix = (play?: boolean) => {
    toggle?.turnOff(play === undefined ? {} : { play });
  };

  if (!ready) return <Loader size="sm" />;

  const snapshots = mixerQuery.data?.snapshots ?? [];
  const canSetDefaults = song.access.capabilities.includes("edit.any");
  // Below 900 px the Mixer button sits above the timeline (the transport has no room for it).
  const buttonRow = !wide;

  return (
    <Section
      title={t("mixer.playerTitle")}
      testId={defaultMix ? "default-mix-panel" : "rehearse-panel"}
    >
      {defaultMix && (
        <Text size="sm" c="dimmed" data-testid="default-mix-note">
          {t("mixer.defaultMixPreparing")}
        </Text>
      )}
      {lockHint && (
        <Alert
          color="blue"
          withCloseButton
          onClose={dismissLockHint}
          data-testid="rehearse-lock-hint"
        >
          <Stack gap="xs">
            <Text size="sm">{t("rehearse.lockHint")}</Text>
            {canPlayMix && (
              <Group>
                <Button
                  size="sm"
                  onClick={() => {
                    playMix(true);
                  }}
                >
                  {t("rehearse.lockHintSwitch")}
                </Button>
              </Group>
            )}
          </Stack>
        </Alert>
      )}
      {playing.length === 0 ? (
        <Text c="dimmed">{t("rehearse.noTracks")}</Text>
      ) : (
        <>
          {!defaultMix && (
            <MixerTools
              songId={song.id}
              snapshots={snapshots}
              canSetDefaults={canSetDefaults}
              defaultsLocked={song.locked !== null}
            />
          )}
          {isPhone && (
            <Group justify="space-between" wrap="nowrap" data-testid="rehearse-readout">
              <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                <CountInCountdown />
                <PositionText size="32px" />
                <BarBeatText size="lg" c="dimmed" />
                <SectionReadout />
              </Group>
              <TransportState />
            </Group>
          )}
          {buttonRow && toggle && (
            <Group wrap="nowrap">
              <MixerButton
                open={!defaultMix}
                onClick={() => {
                  if (defaultMix) toggle.turnOn();
                  else playMix();
                }}
              />
            </Group>
          )}
          {lengthSec > 0 && (
            <Timeline
              lanes={lanes}
              durationSec={lengthSec}
              getPosition={getPosition}
              playing={status === "playing"}
              onSeek={seekSec}
              laneHeight={laneHeight}
              onLaneHeight={setLaneHeight}
              minLaneHeight={minLaneHeight}
              {...timelineMarkers.props}
              {...(!defaultMix && {
                headerWidth: isPhone ? HEADER_W_NARROW : HEADER_W,
                renderHeader: (i: number) => {
                  const p = playing[i];
                  return p ? (
                    <TrackStrip playable={p} song={song} height={laneHeight} compact={isPhone} />
                  ) : null;
                },
              })}
            />
          )}
          <SelectionBar song={song} />
          <SectionChips />
          <MarkerToolbar song={song} />
          <SongComments song={song} />
          <Transport
            phone={isPhone}
            {...(toggle &&
              !buttonRow && {
                mixer: (
                  <MixerButton
                    open={!defaultMix}
                    onClick={() => {
                      if (defaultMix) toggle.turnOn();
                      else playMix();
                    }}
                  />
                ),
              })}
          />
          <TimelineMenu
            song={song}
            menu={timelineMarkers.menu}
            onClose={timelineMarkers.closeMenu}
            durationSec={lengthSec}
          />
          <MarkerEditor song={song} />
          <ShortcutHelp />
        </>
      )}
    </Section>
  );
}

/**
 * Keyboard and pedal shortcuts (SPEC §11.4); Rehearse adds `V` (A/B of the selected track, else
 * the latest pair) and `1–9` (select; Alt: mute; Shift: solo).
 */
function useRehearseKeys(song: Song, defaultMix: boolean) {
  const qc = useQueryClient();
  const onAB = useCallback(() => {
    const s = useRehearse.getState();
    const trackId =
      s.selectedTrackId && s.ab[s.selectedTrackId] ? s.selectedTrackId : Object.keys(s.ab).at(-1);
    if (!trackId) return;
    const versions =
      qc.getQueryData<{ versions: TrackVersion[] }>(songKeys.versions(song.id, trackId))
        ?.versions ?? [];
    toggleAB(trackId, versions);
  }, [qc, song.id]);
  const onTrack = useCallback((index: number, op: "select" | "mute" | "solo") => {
    const s = useRehearse.getState();
    const p = s.tracks[index];
    if (!p) return;
    selectTrack(index);
    const cur = s.mix.tracks[p.track.id];
    if (!cur) return;
    if (op === "mute") setTrack(p.track.id, { mute: !cur.mute });
    if (op === "solo") setTrack(p.track.id, { solo: !cur.solo });
  }, []);
  // The default mix has no mixer: no A/B, no track mute/solo (SPEC §25.5).
  useSongShortcuts(
    song,
    defaultMix
      ? { onCountIn: toggleCountIn, onClick: toggleClick }
      : { onAB, onTrack, onCountIn: toggleCountIn, onClick: toggleClick },
  );
}
