import {
  dbToGain,
  getSongMixer,
  listTrackVersions,
  type Song,
  type Track,
  type TrackVersion,
} from "@bandroom/shared";
import { Alert, Group, Loader, Text } from "@mantine/core";
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
import { COARSE_POINTER_QUERY, PHONE_QUERY } from "../shell/mediaQueries";
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
import { Transport, TransportState } from "./Transport";

const HEADER_W = 320;
/** Phones: name above M/S (DECISIONS 2026-10-07). */
const HEADER_W_NARROW = 116;
/** Default height of the overview strip (SPEC §25.9: the vertical zoom with the Mixer closed). */
export const OVERVIEW_DEFAULT_H = 80;

/**
 * The song Player (SPEC §6, §11.3, §27.4): the engine plays the tracks with the personal mix in
 * both Mixer states. The transport sits at the top, then the overview (the audible tracks summed;
 * its height is the vertical zoom with the Mixer closed). `mixerOpen` adds the mixer tools below
 * the overview and one lane per track with its header (narrow on phones, DECISIONS 2026-10-06);
 * nothing above them moves and the engine keeps playing.
 */
export function RehearsePanel({
  song,
  tracks,
  mixerOpen,
}: {
  song: Song;
  tracks: Track[];
  mixerOpen: boolean;
}) {
  const { t } = useTranslation();
  const user = useOptionalUser();
  const instrumentTag = user?.instrumentTag ?? "";
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
    void openSong(song.id, tracks, saved, listened, instrumentTag);
  }, [ready, song.id, tracks, saved, listened, instrumentTag]);
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
  useRehearseKeys(song);

  const playing = useRehearse((s) => s.tracks);
  // Only mute/solo matter to the lanes: a fader move must not rebuild them (and redraw the
  // waveforms).
  const dimmedKey = useRehearse((s) => dimmedTrackIds(s.mix).join("\n"));
  const status = useRehearse((s) => s.status);
  const lengthSec = useRehearse((s) => s.lengthSec);
  const lockHint = useRehearse((s) => s.lockHint);

  const hashes = playing.map((p) => p.version.variants.peaks?.hash ?? null);
  const pyramids = usePeaks(hashes);
  const lanes = useMemo(
    () =>
      playing.map((p, i) => ({
        id: p.track.id,
        color: p.track.color,
        offsetSamples: p.version.offsetSamples,
        peaks: pyramids[i] ?? null,
        dimmed: dimmedKey.split("\n").includes(p.track.id),
        // The version's gain shows in the waveform; the personal fader does not (§25.6).
        scale: dbToGain(p.version.gainDb),
        tint: true,
      })),
    [playing, pyramids, dimmedKey],
  );
  const getPosition = useCallback(() => positionSec(), []);
  // Vertical zoom (SPEC §25.9), per device: the overview strip with the Mixer closed (it keeps
  // that height when the Mixer opens), the track lanes with it open. On touch screens the lanes
  // stay tall enough for 44 px M/S buttons.
  const minLaneHeight = coarse ? touchMinLaneHeight(isPhone) : MIN_LANE_H;
  const [overviewHeight, setOverviewHeight] = useLaneHeight("listen.summed", OVERVIEW_DEFAULT_H);
  const [trackLaneHeight, setTrackLaneHeight] = useLaneHeight(
    "rehearse",
    isPhone ? 66 : 100,
    minLaneHeight,
  );
  const laneHeight = mixerOpen ? trackLaneHeight : overviewHeight;
  const timelineMarkers = useTimelineMarkers(
    song,
    lengthSec,
    mixerOpen ? lanes.length : 0,
    trackLaneHeight,
  );

  if (!ready) return <Loader size="sm" />;

  const snapshots = mixerQuery.data?.snapshots ?? [];
  const canSetDefaults = song.access.capabilities.includes("edit.any");

  return (
    <Section title={t("mixer.playerTitle")} testId="rehearse-panel">
      {lockHint && (
        <Alert
          color="blue"
          withCloseButton
          onClose={dismissLockHint}
          data-testid="rehearse-lock-hint"
        >
          <Text size="sm">{t("rehearse.lockHint")}</Text>
        </Alert>
      )}
      {playing.length === 0 ? (
        <Text c="dimmed">{t("rehearse.noTracks")}</Text>
      ) : (
        <>
          <Transport phone={isPhone} />
          {isPhone && (
            // A fixed minimum height: the section name appearing must not move the page.
            <Group
              gap="sm"
              wrap="wrap"
              mih={30}
              data-testid="rehearse-readout"
              style={{ rowGap: 0 }}
            >
              <CountInCountdown />
              <BarBeatText size="lg" c="dimmed" />
              <SectionReadout />
              <TransportState />
            </Group>
          )}
          {lengthSec > 0 && (
            <Timeline
              lanes={lanes}
              durationSec={lengthSec}
              getPosition={getPosition}
              playing={status === "playing"}
              onSeek={seekSec}
              hideLanes={!mixerOpen}
              overviewHeight={overviewHeight}
              laneHeight={laneHeight}
              onLaneHeight={mixerOpen ? setTrackLaneHeight : setOverviewHeight}
              minLaneHeight={mixerOpen ? minLaneHeight : MIN_LANE_H}
              {...timelineMarkers.props}
              {...(mixerOpen && {
                belowOverview: (
                  <MixerTools
                    songId={song.id}
                    snapshots={snapshots}
                    canSetDefaults={canSetDefaults}
                    defaultsLocked={song.locked !== null}
                  />
                ),
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
function useRehearseKeys(song: Song) {
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
  useSongShortcuts(song, { onAB, onTrack, onCountIn: toggleCountIn, onClick: toggleClick });
}
