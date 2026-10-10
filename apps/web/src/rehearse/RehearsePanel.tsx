import {
  clickAudible,
  clickSettingsOf,
  dbToGain,
  dimmedTrackIds,
  listTrackVersions,
  type Song,
  type Track,
  type TrackVersion,
} from "@bandroom/shared";
import { ActionIcon, Alert, Box, Loader, Menu, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { IconAdjustmentsHorizontal, IconMicrophoneOff } from "@tabler/icons-react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "../api/client";
import { useOptionalUser } from "../auth/session";
import { fetchSongMixer, tracksNeedingVersions } from "../player/queueLoader";
import { songKeys } from "../features/library/queries";
import { Timeline } from "../timeline/Timeline";
import { MIN_LANE_H, useLaneHeight } from "../timeline/laneHeight";
import { usePeaks } from "../timeline/usePeaks";
import {
  MarkerEditor,
  SectionPills,
  SelectionBar,
  TimelineMenu,
  useTimelineMarkers,
} from "../markers/SongMarkers";
import { ShortcutHelp, useSongShortcuts } from "../markers/shortcuts";
import { SongComments } from "../comments/CommentsPanel";
import { registerPlayer } from "../markers/store";
import {
  attachPage,
  dismissLockHint,
  durationSec,
  hasMyInstrument,
  muteMyInstrument,
  loadPageSongForRecording,
  openSong,
  pageIsPlaying,
  pageState,
  positionSec,
  prepareEngine,
  seekSec,
  selectTrack,
  songInfoOf,
  setLoopSec,
  setTrack,
  toggleAB,
  toggleClick,
  toggleCountIn,
  togglePagePlay,
  usePlayerView,
  useRehearse,
} from "./controller";
import { ClickToggles } from "./ClickControls";
import { touchMinLaneHeight } from "./headerTier";
import { BounceModal } from "./BounceModal";
import { MixerMenuItems, MixerTools, MuteMineButton, SaveSnapshotDialog } from "./MixerTools";
import { CLICK_LANE_COLOR, ClickStrip } from "./ClickStrip";
import { TrackStrip } from "./TrackStrip";
import { useTempoUi } from "../tempo/store";
import type { Lane } from "../timeline/render";
import { openPracticeSheet, PracticePhoneButton, practiceShortcut } from "./PracticeControls";
import {
  ContextRow,
  ControlBar,
  RowDivider,
  SectionsToggle,
  ZoomMenuItems,
  ZoomTools,
  type BarSongSlots,
} from "./Transport";
import { barSizes, useBarLayout, useCoarsePointer } from "./barLayout";
import { AddMarkerButton, MarkerMenuItems, MarkerToolbar } from "../markers/MarkerToolbar";
import { LanesMenu } from "../markers/LanesMenu";
import { TempoDialogHost } from "../tempo/TempoDialog";
import { isLinkMode } from "../links/linkMode";
import { RecordSheet } from "../record/RecordSheet";
import { recordingSupported } from "../record/opfs";
import { useOnline } from "../offline/online";
import { offlineItemFor, useOffline } from "../offline/controller";
import { TimelineItemsDialog } from "../markers/TimelineItemsDialog";
import { ClipOverlay, CLIP_ITEM_PREFIX } from "../edit/ClipOverlay";
import {
  laneClipsOf,
  useEditPeakHashes,
  useEditPlaybackSync,
  useEditSnapSync,
} from "../edit/engineSync";
import { outOfSync } from "../edit/model";
import { pickClip, startPicking, useEdit } from "../edit/store";
import { useEditShortcuts } from "../edit/shortcuts";
import { RULER_H } from "../timeline/Timeline";
import type { View } from "../timeline/view";

const HEADER_W = 320;
/** Phones: name above M/S (DECISIONS 2026-10-07). */
const HEADER_W_NARROW = 116;
/** Phones in landscape: about 3½ tracks visible (SPEC §31.6). */
const HEADER_W_LANDSCAPE = 150;
/** The label column of the top lanes while the Mixer is closed (fits "Komentáře" at xs). */
const LABEL_W = 88;
const LABEL_W_PHONE = 72;
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
  songPath,
  bar,
  editRow,
}: {
  song: Song;
  tracks: Track[];
  mixerOpen: boolean;
  /** Where the page of another song is: the page follows the queue moving on (SPEC §6.10). */
  songPath?: (songId: string) => string;
  /** The song page's parts of the control bar (SPEC §31); link pages pass none. */
  bar?: BarSongSlots;
  /** Edit mode: row 2 of the control bar (SPEC §31.2). */
  editRow?: ReactNode;
}) {
  const { t } = useTranslation();
  const user = useOptionalUser();
  const instrumentTag = user?.instrumentTag ?? "";
  const userInstrument = user?.instrument ?? null;
  const me = useMemo(
    () => ({ instrumentTag, instrument: userInstrument }),
    [instrumentTag, userInstrument],
  );
  const layout = useBarLayout();
  // A small phone in landscape still matches the phone width; its layout is the landscape one.
  const isPhone = layout === "phone";
  const landscape = layout === "landscape";
  const narrow = layout !== "desktop";
  const coarse = useCoarsePointer();
  const mixerQuery = useQuery({
    queryKey: songKeys.mixer(song.id),
    queryFn: ({ signal }) => fetchSongMixer(song.id, signal),
  });

  // Personal listened versions that are not the current one need their version data.
  const saved = mixerQuery.data?.state ?? null;
  const needVersions = tracksNeedingVersions(tracks, saved);
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
  // Leaving the page keeps a playing song (the mini-player takes over, SPEC §6.10). Attached
  // before the song opens: while another song plays, the page shows this one as a preview.
  useEffect(() => attachPage(song.id), [song.id]);
  useEffect(() => {
    if (!ready) return;
    void openSong(song.id, tracks, saved, listened, me, songInfoOf(song));
  }, [ready, song, tracks, saved, listened, me]);
  useFollowQueue(song.id, songPath);

  useEffect(
    () =>
      registerPlayer({
        position: positionSec,
        duration: durationSec,
        seek: seekSec,
        setLoop: setLoopSec,
        togglePlay: togglePagePlay,
        isPlaying: pageIsPlaying,
      }),
    [],
  );
  useRehearseKeys(song);

  // The engine's state, or the preview while another song plays on (SPEC §6.10).
  const shownSongId = usePlayerView((s) => s.songId);
  const playing = usePlayerView((s) => s.tracks);
  // Only mute/solo matter to the lanes: a fader move must not rebuild them (and redraw the
  // waveforms).
  const dimmedKey = usePlayerView((s) => dimmedTrackIds(s.mix).join("\n"));
  const status = usePlayerView((s) => s.status);
  // Open-ended (no tracks, recording): a virtual length that grows with the playhead (SPEC §9).
  const timelineSec = usePlayerView((s) => s.timelineSec);
  const lockHint = usePlayerView((s) => s.lockHint);
  // Bounce (SPEC §5.5): offered when the user may create songs in the project.
  const [bounceOpen, setBounceOpen] = useState(false);
  // Record (SPEC §9): `record` on the song, a browser that can, and the song online or saved
  // offline on this device.
  const online = useOnline();
  const savedOffline = useOffline((st) => offlineItemFor(song.id, st.items) !== undefined);
  const [recordOpen, setRecordOpen] = useState(false);
  const mayRecord = song.access.capabilities.includes("record") && recordingSupported();
  const onRecord =
    mayRecord && (online || savedOffline)
      ? () => {
          // Inside the tap: the audio unlocks (iOS) and a previewed song moves into the engine.
          prepareEngine();
          loadPageSongForRecording();
          setRecordOpen(true);
        }
      : undefined;
  const closeRecord = useCallback(() => {
    setRecordOpen(false);
  }, []);
  const onBounce =
    song.canBounce && playing.length > 0
      ? () => {
          setBounceOpen(true);
        }
      : undefined;

  // Edit mode (SPEC §24.6): the lanes show the session's clips; the engine plays them.
  const editing = useEdit((s) => s.songId === song.id && s.state !== null);
  const editState = useEdit((s) => (s.songId === song.id ? s.state : null));
  const editVersions = useEdit((s) => s.versions);
  const picking = useEdit((s) => s.picking);
  useEditPlaybackSync(song.id);
  useEditSnapSync(song.id);
  const editHashes = useEditPeakHashes(song.id);
  const playingHashes = playing.map((p) => p.version.variants.peaks?.hash ?? null);
  const hashes = [...playingHashes, ...editHashes.filter((h) => !playingHashes.includes(h))];
  const allPyramids = usePeaks(hashes);
  const pyramids = allPyramids.slice(0, playing.length);
  const peaksByHash = useMemo(
    () => new Map(hashes.map((h, i) => [h ?? "", allPyramids[i] ?? null])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the hashes are in the pyramids' key
    [allPyramids],
  );
  // The click lane (SPEC §11.3, DECISIONS 2026-10-07): last, with the Mixer open and a tempo
  // map; never in the overview.
  const grid = useTempoUi((s) => (s.songId === song.id ? s.grid : null));
  const clickKey = usePlayerView((s) => {
    const c = clickSettingsOf(s.mix);
    return [c.subdivision, c.compoundEighths, c.accent, clickAudible(s.mix)].join(":");
  });
  const trackLanes = useMemo(
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
        ...(editState && {
          clips: laneClipsOf(
            editState.tracks.find((x) => x.trackId === p.track.id)?.clips ?? [],
            editVersions,
            peaksByHash,
          ),
        }),
      })),
    [playing, pyramids, dimmedKey, editState, editVersions, peaksByHash],
  );
  const lanes = useMemo((): Lane[] => {
    if (!mixerOpen || !grid) return trackLanes;
    const [sub, eighths, accent, audible] = clickKey.split(":");
    const click: Lane = {
      id: "click",
      color: CLICK_LANE_COLOR,
      offsetSamples: 0,
      peaks: null,
      dimmed: audible !== "true",
      tint: true,
      click: {
        grid,
        subdivision: sub === "4" ? 4 : sub === "2" ? 2 : 1,
        compoundEighths: eighths === "true",
        accent: accent === "true",
      },
    };
    return [...trackLanes, click];
  }, [trackLanes, mixerOpen, grid, clickKey]);
  const getPosition = useCallback(() => positionSec(), []);
  // Vertical zoom (SPEC §25.9), per device: the overview strip with the Mixer closed (it keeps
  // that height when the Mixer opens), the track lanes with it open. On touch screens the lanes
  // stay tall enough for 44 px M/S buttons.
  const minLaneHeight = coarse ? touchMinLaneHeight(narrow) : MIN_LANE_H;
  const [overviewHeight, setOverviewHeight] = useLaneHeight("listen.summed", OVERVIEW_DEFAULT_H);
  const [trackLaneHeight, setTrackLaneHeight] = useLaneHeight(
    "rehearse",
    landscape ? 72 : isPhone ? 66 : 100,
    minLaneHeight,
  );
  const laneHeight = mixerOpen ? trackLaneHeight : overviewHeight;
  const timelineMarkers = useTimelineMarkers(
    song,
    timelineSec,
    mixerOpen ? lanes.length : 0,
    trackLaneHeight,
  );
  const editLanes = useMemo(
    () => playing.map((p) => ({ trackId: p.track.id, color: p.track.color })),
    [playing],
  );
  const editOps = useEdit((s) => s.ops);
  const editCursor = useEdit((s) => s.cursor);
  const shifted = useMemo(
    () =>
      editing
        ? outOfSync(
            editOps,
            editCursor,
            playing.map((p) => p.track.id),
          )
        : {},
    [editing, editOps, editCursor, playing],
  );
  useEditShortcuts(editing);
  const markerProps = timelineMarkers.props;
  // Edit mode: clips over the track lanes; touch taps and long-presses on them arrive through
  // the timeline (a tap seeks, or adds while picking; a long-press starts picking).
  const timelineProps =
    editing && mixerOpen
      ? {
          ...markerProps,
          renderOverlay: (v: View) => (
            <>
              {markerProps.renderOverlay?.(v)}
              <ClipOverlay
                view={v}
                top={(markerProps.rulerHeight ?? RULER_H) + (markerProps.topLanesHeight ?? 0)}
                laneHeight={laneHeight}
                lanes={editLanes}
                markers={timelineMarkers.markers}
              />
            </>
          ),
          onItemTap: (id: string, sec: number) => {
            if (!id.startsWith(CLIP_ITEM_PREFIX)) {
              markerProps.onItemTap?.(id, sec);
              return;
            }
            if (picking) pickClip(id.slice(CLIP_ITEM_PREFIX.length), true);
            else seekSec(sec);
          },
          onLongPress: (sec: number, x: number, y: number, item: string | null) => {
            if (item?.startsWith(CLIP_ITEM_PREFIX)) {
              startPicking(item.slice(CLIP_ITEM_PREFIX.length));
              return;
            }
            markerProps.onLongPress?.(sec, x, y, item);
          },
        }
      : markerProps;

  // Another song's state (before this one opens, or the queue moving the page on).
  if (!ready || shownSongId !== song.id) return <Loader size="sm" />;

  const snapshots = mixerQuery.data?.snapshots ?? [];
  const canSetDefaults = song.access.capabilities.includes("edit.any");
  const mixerProps = {
    songId: song.id,
    snapshots,
    canSetDefaults,
    defaultsLocked: song.locked !== null,
    onBounce,
  };
  const row = barSizes(coarse).row;

  // Row 2 (SPEC §31.1): desktop mixer (Mixer open), marker and zoom tools, then Sections;
  // phones count-in, click, Practice, mute mine, Mixer, add marker and Sections; landscape none.
  const contextRow =
    layout === "desktop" ? (
      <ContextRow coarse={coarse} label={t("rehearse.moreTools")}>
        <LanesMenu size={row} />
        {mixerOpen && <MixerTools {...mixerProps} size={row} />}
        <RowDivider />
        <MarkerToolbar song={song} size={row} />
        <RowDivider />
        <ZoomTools size={row} />
        <Box ml="auto">
          <SectionsToggle size={row} labelled />
        </Box>
      </ContextRow>
    ) : isPhone ? (
      <ContextRow coarse label={t("rehearse.moreTools")} spread>
        <ClickToggles size={44} />
        <PracticePhoneButton onOpen={openPracticeSheet} />
        <MuteMineButton size={44} />
        {bar?.mixer && (
          <Tooltip label={t("rehearse.mixer")}>
            <ActionIcon
              size={44}
              variant={bar.mixer.open ? "filled" : "subtle"}
              color={bar.mixer.open ? undefined : "gray"}
              disabled={bar.mixer.disabled}
              aria-pressed={bar.mixer.open}
              aria-label={t("rehearse.mixer")}
              onClick={bar.mixer.toggle}
              data-testid="mixer-toggle"
            >
              <IconAdjustmentsHorizontal size={20} />
            </ActionIcon>
          </Tooltip>
        )}
        <AddMarkerButton song={song} size={44} />
        <SectionsToggle size={44} labelled={false} />
      </ContextRow>
    ) : null;
  // Phone and landscape "⋯": what row 2 has on desktop (SPEC §31.1).
  const moreItems = narrow ? (
    <>
      {landscape && <MenuMuteMine />}
      {mixerOpen && <MixerMenuItems {...mixerProps} />}
      <MarkerMenuItems song={song} withAddMarker={landscape} />
      <ZoomMenuItems />
    </>
  ) : undefined;

  return (
    <Paper
      withBorder
      radius={narrow ? 0 : "md"}
      data-testid="rehearse-panel"
      style={{
        // Phones: the Player spans the screen (the page padding is outside it).
        ...(narrow && {
          marginInline: "calc(var(--mantine-spacing-md) * -1)",
          borderInline: "none",
        }),
      }}
    >
      {lockHint && (
        <Alert
          color="blue"
          withCloseButton
          onClose={dismissLockHint}
          m="xs"
          data-testid="rehearse-lock-hint"
        >
          <Text size="sm">{t("rehearse.lockHint")}</Text>
        </Alert>
      )}
      <ControlBar
        layout={layout}
        coarse={coarse}
        onBounce={onBounce}
        onRecord={onRecord}
        slots={bar}
        contextRow={contextRow}
        moreItems={moreItems}
        editRow={editRow}
      />
      {/* Below the sticky bar: the pills scroll with the page (SPEC §31.3). */}
      <SectionPills song={song} />
      {timelineSec > 0 && (
        <Timeline
          lanes={lanes}
          durationSec={timelineSec}
          getPosition={getPosition}
          playing={status === "playing"}
          onSeek={seekSec}
          hideLanes={!mixerOpen}
          labelWidth={isPhone ? LABEL_W_PHONE : LABEL_W}
          overviewHeight={overviewHeight}
          laneHeight={laneHeight}
          onLaneHeight={mixerOpen ? setTrackLaneHeight : setOverviewHeight}
          minLaneHeight={mixerOpen ? minLaneHeight : MIN_LANE_H}
          {...timelineProps}
          {...(mixerOpen && {
            headerWidth: isPhone ? HEADER_W_NARROW : landscape ? HEADER_W_LANDSCAPE : HEADER_W,
            renderHeader: (i: number) => {
              const p = playing[i];
              if (p)
                return (
                  <TrackStrip
                    playable={p}
                    song={song}
                    height={laneHeight}
                    compact={narrow}
                    edit={editing ? { outOfSync: shifted[p.track.id] ?? 0 } : undefined}
                  />
                );
              return lanes[i]?.click ? <ClickStrip height={laneHeight} compact={narrow} /> : null;
            },
          })}
        />
      )}
      <Stack gap="md" p={{ base: "sm", sm: "md" }}>
        {playing.length === 0 && (
          // Nothing to play yet: the click still runs (SPEC §9).
          <Text size="sm" c="dimmed" data-testid="rehearse-no-tracks">
            {t("rehearse.noTracks")}
          </Text>
        )}
        <SelectionBar song={song} />
        <SongComments song={song} />
      </Stack>
      <TimelineMenu
        song={song}
        menu={timelineMarkers.menu}
        onClose={timelineMarkers.closeMenu}
        durationSec={timelineSec}
      />
      <MarkerEditor song={song} />
      <TimelineItemsDialog song={song} />
      <ShortcutHelp />
      <TempoDialogHost song={song} />
      <SaveSnapshotDialog songId={song.id} />
      {/* Stays while recording when the network goes (the take is kept for later). */}
      {mayRecord && (
        <RecordSheet
          opened={recordOpen}
          onClose={closeRecord}
          scope={{ mode: "song", songId: song.id, projectId: song.project.id }}
        />
      )}
      {onBounce && (
        <BounceModal
          song={song}
          opened={bounceOpen}
          onClose={() => {
            setBounceOpen(false);
          }}
        />
      )}
    </Paper>
  );
}

/** "Mute my instrument" in the landscape "⋯" (SPEC §31.6). */
function MenuMuteMine() {
  const { t } = useTranslation();
  if (isLinkMode()) return null;
  const mine = hasMyInstrument();
  return (
    <Menu.Item
      leftSection={<IconMicrophoneOff size={14} />}
      closeMenuOnClick
      disabled={!mine}
      onClick={muteMyInstrument}
      data-testid="mixer-mute-mine"
    >
      {mine ? t("rehearse.muteMine") : t("rehearse.setInstrument")}
    </Menu.Item>
  );
}

/**
 * The queue moved on from this page's song (its end, media controls): the page follows to the
 * song that now plays, so the Player never shows another song's audio.
 */
function useFollowQueue(songId: string, songPath?: (songId: string) => string) {
  const navigate = useNavigate();
  const playing = useRehearse((s) => (s.open ? s.songId : null));
  const prev = useRef(playing);
  useEffect(() => {
    const was = prev.current;
    prev.current = playing;
    if (songPath && was === songId && playing !== null && playing !== songId) {
      void navigate(songPath(playing));
    }
  }, [playing, songId, songPath, navigate]);
}

/**
 * Keyboard and pedal shortcuts (SPEC §11.4); Rehearse adds `V` (A/B of the selected track, else
 * the latest pair) and `1–9` (select; Alt: mute; Shift: solo).
 */
function useRehearseKeys(song: Song) {
  const qc = useQueryClient();
  const onAB = useCallback(() => {
    const s = pageState();
    const trackId =
      s.selectedTrackId && s.ab[s.selectedTrackId] ? s.selectedTrackId : Object.keys(s.ab).at(-1);
    if (!trackId) return;
    const versions =
      qc.getQueryData<{ versions: TrackVersion[] }>(songKeys.versions(song.id, trackId))
        ?.versions ?? [];
    toggleAB(trackId, versions);
  }, [qc, song.id]);
  const onTrack = useCallback((index: number, op: "select" | "mute" | "solo") => {
    const s = pageState();
    const p = s.tracks[index];
    if (!p) return;
    selectTrack(index);
    const cur = s.mix.tracks[p.track.id];
    if (!cur) return;
    if (op === "mute") setTrack(p.track.id, { mute: !cur.mute });
    if (op === "solo") setTrack(p.track.id, { solo: !cur.solo });
  }, []);
  useSongShortcuts(song, {
    onAB,
    onTrack,
    onCountIn: toggleCountIn,
    onClick: toggleClick,
    onPractice: practiceShortcut,
  });
}
