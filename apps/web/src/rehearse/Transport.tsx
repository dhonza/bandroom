import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Menu,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowsHorizontal,
  IconCheck,
  IconDots,
  IconFileMusic,
  IconKeyboard,
  IconListDetails,
  IconMetronome,
  IconMicrophone,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBackFilled,
  IconPlayerTrackNextFilled,
  IconPlayerTrackPrevFilled,
  IconRewindBackward5,
  IconRewindForward5,
  IconZoomIn,
  IconZoomOut,
} from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  openPracticeSheet,
  PracticeButton,
  PracticeMenuItem,
  PracticePhoneButton,
  PracticeSheet,
} from "./PracticeControls";
import { formatClock } from "../player/format";
import { musicalSnap, SNAP_MODES } from "../markers/model";
import { BarBeatText, MeterText } from "../tempo/readout";
import { hasMeterChanges } from "../tempo/meterChanges";
import { useTempoUi } from "../tempo/store";
import {
  ClickMenuItems,
  ClickSettingsModal,
  ClickToggles,
  CountInCountdown,
  LoopCountInOptions,
} from "./ClickControls";
import { LaneMenuItems } from "../markers/LanesMenu";
import {
  LoopButton,
  PillsIcon,
  SectionReadout,
  useCurrentSectionId,
  usePillsOn,
  useTogglePills,
} from "../markers/SongMarkers";
import {
  goNext,
  goPrev,
  playPause,
  setHelpOpen,
  setItemsOpen,
  setSnap,
  useTimelineUi,
} from "../markers/store";
import { positionSec, retryAudio, seekSec, setPrefs, skip, usePlayerView } from "./controller";
import type { QualityPref } from "./model";
import { useEdit } from "../edit/store";
import { chromeAutoOnly, showChrome, useChrome } from "../shell/chrome";
import { requestFit, requestZoom } from "../timeline/zoom";
import { barSizes, type BarLayout } from "./barLayout";

const QUALITIES: QualityPref[] = ["auto", "lossless", "high", "low"];
const WAKE: ("off" | "playing" | "songOpen")[] = ["off", "playing", "songOpen"];

/**
 * Position text updated every animation frame straight in the DOM (no React re-render).
 * `withMs: false` shows m:ss (the phone transport row has no room for milliseconds).
 */
export function PositionText({
  size,
  withMs = true,
}: {
  size: "xl" | "lg" | "32px";
  withMs?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = "";
    const tick = () => {
      const text = formatClock(positionSec(), withMs);
      if (text !== last && ref.current) {
        ref.current.textContent = text;
        last = text;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [withMs]);
  return (
    <Text
      component="span"
      ref={ref}
      size={size}
      fw={700}
      className="tabular-nums"
      data-testid="rehearse-position"
    >
      {formatClock(0, withMs)}
    </Text>
  );
}

/** Opens the record sheet (SPEC §9): in the desktop transport; phones have it in "⋯". */
export function RecordButton({ onRecord, size = 44 }: { onRecord: () => void; size?: number }) {
  const { t } = useTranslation();
  return (
    <Tooltip label={t("record.open")}>
      <ActionIcon
        size={size}
        variant="subtle"
        color="red"
        aria-label={t("record.open")}
        onClick={onRecord}
        data-testid="record-open"
      >
        <IconMicrophone size={20} color="var(--mantine-color-red-filled)" />
      </ActionIcon>
    </Tooltip>
  );
}

/** Loading/struggling badges (shown next to the readout). */
export function TransportState() {
  const { t } = useTranslation();
  const status = usePlayerView((s) => s.status);
  const struggling = usePlayerView((s) => s.struggling);
  return (
    <Group gap={6} wrap="nowrap">
      {(status === "loading" || status === "buffering") && <Loader size="xs" />}
      {status === "loading" && (
        <Text size="xs" c="dimmed">
          {t("rehearse.loading")}
        </Text>
      )}
      {struggling && (
        <Tooltip label={t("rehearse.strugglingTip")} multiline w={220}>
          <Badge
            color="orange"
            variant="light"
            leftSection={<IconAlertTriangle size={12} />}
            data-testid="rehearse-struggling"
          >
            {t("rehearse.struggling")}
          </Badge>
        </Tooltip>
      )}
    </Group>
  );
}

/**
 * What the song page adds to the control bar (SPEC §31.2, §31.6): the landscape row's back link
 * and compact title, "Edit audio", the song's menu items, and the Mixer toggle (phones put it in
 * row 2). Link pages pass nothing.
 */
export interface BarSongSlots {
  backTo: string;
  backLabel: string;
  title: string;
  /** The song info line under the compact title ("D · 120 BPM · 4/4"). */
  info?: ReactNode;
  editAudio?: ReactNode;
  /** The song's actions for the landscape "⋯" (Song preferences, offline, follow, lock…). */
  menuItems?: ReactNode;
  mixer?: { open: boolean; toggle: () => void; disabled: boolean };
}

/** The boxed meter at the playhead, only when the song changes meter (SPEC §31.5). */
export function MeterBox({ size }: { size: "xs" | "sm" }) {
  const changes = useTempoUi((s) => hasMeterChanges(s.grid));
  if (!changes) return null;
  return (
    <MeterText
      size={size}
      fw={700}
      px={4}
      lh={size === "xs" ? "16px" : "18px"}
      style={{
        border: "1px solid var(--mantine-color-default-border)",
        borderRadius: 4,
        alignSelf: "center",
      }}
    />
  );
}

/** The "Sections" toggle that shows or hides the section pills (SPEC §31.3). */
export function SectionsToggle({ size, labelled }: { size: number; labelled: boolean }) {
  const { t } = useTranslation();
  const on = usePillsOn();
  const toggle = useTogglePills();
  const label = on ? t("markers.pills.hide") : t("markers.pills.show");
  if (labelled) {
    return (
      <Tooltip label={label}>
        <Button
          size="compact-xs"
          h={24}
          variant={on ? "light" : "default"}
          leftSection={<PillsIcon size={15} />}
          aria-pressed={on}
          onClick={toggle}
          data-testid="section-pills-toggle"
        >
          {t("markers.pills.toggle")}
        </Button>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={label}>
      <ActionIcon
        size={size}
        variant={on ? "light" : "subtle"}
        color={on ? undefined : "gray"}
        aria-pressed={on}
        aria-label={t("markers.pills.toggle")}
        onClick={toggle}
        data-testid="section-pills-toggle"
      >
        <PillsIcon size={20} />
      </ActionIcon>
    </Tooltip>
  );
}

/**
 * Phones and landscape: the position, bar.beat and the meter over the current section's name. A
 * tap shows or hides the section pills (SPEC §31.3).
 */
function ReadoutButton({ grow, ms }: { grow: boolean; ms: boolean }) {
  const { t } = useTranslation();
  const on = usePillsOn();
  const toggle = useTogglePills();
  const id = useCurrentSectionId();
  const name = useTimelineUi((s) => s.markers.find((m) => m.id === id)?.name ?? null);
  return (
    <UnstyledButton
      onClick={toggle}
      aria-pressed={on}
      aria-label={name ? t("markers.pills.readout", { name }) : t("markers.pills.readoutNoSection")}
      data-testid="transport-readout"
      style={{
        flex: grow ? "1 1 auto" : "none",
        minWidth: 0,
        height: 44,
        paddingInline: 6,
        borderRadius: "var(--mantine-radius-md)",
        display: "flex",
        flexDirection: "column",
        alignItems: grow ? "center" : "flex-start",
        justifyContent: "center",
        lineHeight: 1.15,
        overflow: "hidden",
        background: on ? "var(--mantine-primary-color-light)" : undefined,
      }}
    >
      <Group gap={6} wrap="nowrap" align="baseline">
        <CountInCountdown />
        <PositionText size="lg" withMs={ms} />
        <BarBeatText size="sm" fw={500} c="dimmed" />
        <MeterBox size="xs" />
      </Group>
      <Group gap={4} wrap="nowrap" style={{ minWidth: 0, maxWidth: "100%" }}>
        <SectionReadout size="xs" />
        <TransportState />
        <PillsIcon size={12} />
      </Group>
    </UnstyledButton>
  );
}

/**
 * The control bar (SPEC §31.1): one sticky box under the app header with the transport (row 1)
 * and the context row (row 2: mixer, marker and zoom tools, or the edit tools). Desktop: start,
 * previous, −5 s, play, +5 s, next, loop, the readouts, count-in, click, Practice, Record and
 * "⋯". Phones: loop, previous, play, next, the readout button and "⋯". Landscape phones: one row
 * with the back link, the compact title and the tools of row 2.
 */
export function ControlBar({
  layout,
  coarse,
  onBounce,
  onRecord,
  slots,
  contextRow,
  moreItems,
  editRow,
}: {
  layout: BarLayout;
  coarse: boolean;
  /** Opens "Bounce to new song…" (SPEC §5.5); absent when the user may not bounce. */
  onBounce?: (() => void) | undefined;
  /** Opens the record sheet (SPEC §9); absent when the user may not record here. */
  onRecord?: (() => void) | undefined;
  slots?: BarSongSlots | undefined;
  /** Row 2 (none in landscape normal mode). */
  contextRow: ReactNode;
  /** Phone and landscape "⋯": the tools that row 2 has on desktop. */
  moreItems?: ReactNode;
  /** Edit mode: row 2 is the orange edit row (landscape: below the transport). */
  editRow?: ReactNode;
}) {
  const { t } = useTranslation();
  const status = usePlayerView((s) => s.status);
  const sizes = barSizes(coarse || layout !== "desktop");
  const playing = status === "playing" || status === "buffering";
  const [clickSettings, setClickSettingsOpen] = useState(false);
  const editing = editRow !== undefined && editRow !== null;
  const loop = <LoopButton size={sizes.transport} options={<LoopCountInOptions />} />;
  const icon = (label: string, onClick: () => void, child: ReactNode, testId?: string) => (
    <ActionIcon
      size={sizes.transport}
      variant="subtle"
      color="gray"
      aria-label={label}
      onClick={onClick}
      data-testid={testId}
    >
      {child}
    </ActionIcon>
  );
  const play = (
    <ActionIcon
      size={layout === "landscape" ? 44 : sizes.play}
      radius="xl"
      variant="filled"
      onClick={playPause}
      disabled={status === "idle"}
      aria-label={playing ? t("listen.pause") : t("listen.play")}
      data-testid="rehearse-play"
    >
      {playing ? <IconPlayerPauseFilled size={22} /> : <IconPlayerPlayFilled size={22} />}
    </ActionIcon>
  );
  const prev = icon(t("markers.prev"), goPrev, <IconPlayerTrackPrevFilled size={18} />, "go-prev");
  const next = icon(t("markers.next"), goNext, <IconPlayerTrackNextFilled size={18} />, "go-next");

  const options = (
    <PlaybackMenu
      layout={layout}
      onBounce={onBounce}
      onRecord={layout === "desktop" ? undefined : onRecord}
      slots={slots}
      moreItems={moreItems}
      size={sizes.transport}
      onClickSettings={() => {
        setClickSettingsOpen(true);
      }}
    />
  );

  const interrupted = status === "interrupted" && (
    <Text size="sm" c="orange" px={8} data-testid="rehearse-interrupted">
      {t("rehearse.interrupted")}
    </Text>
  );
  const startFailed = status === "error" && (
    <Group gap="xs" wrap="wrap" px={8} data-testid="rehearse-start-failed">
      <Text size="sm" c="red">
        {t("rehearse.startFailed")}
      </Text>
      <Button size="compact-md" mih={44} variant="light" onClick={retryAudio}>
        {t("common.retry")}
      </Button>
    </Group>
  );

  let row1: ReactNode;
  if (layout === "phone") {
    row1 = (
      <Group gap={2} wrap="nowrap" px={4} py={4}>
        {loop}
        {prev}
        {play}
        {next}
        <ReadoutButton grow ms={false} />
        {options}
      </Group>
    );
  } else if (layout === "landscape") {
    row1 = (
      <Group gap={0} wrap="nowrap" px={4} h={48}>
        {slots && (
          <>
            <ActionIcon
              component={Link}
              to={slots.backTo}
              size={44}
              w={36}
              miw={36}
              variant="subtle"
              aria-label={slots.backLabel}
              data-testid="song-back"
            >
              <IconArrowLeft size={20} />
            </ActionIcon>
            <Stack gap={0} w={editing ? 118 : 96} style={{ flex: "none", minWidth: 0 }}>
              <Text size="sm" fw={700} truncate="end" data-testid="song-title-compact">
                {slots.title}
              </Text>
              {editing ? <EditingLabel /> : slots.info}
            </Stack>
            <Divider orientation="vertical" mx={4} my={10} />
          </>
        )}
        {loop}
        {prev}
        {play}
        {next}
        <ReadoutButton grow={false} ms />
        <Box style={{ flex: "1 1 0", minWidth: 0 }} />
        <ClickToggles size={44} />
        <PracticePhoneButton onOpen={openPracticeSheet} />
        <SectionsToggle size={44} labelled={false} />
        {!editing && slots?.editAudio}
        {options}
      </Group>
    );
  } else {
    row1 = (
      <Group gap={12} wrap="wrap" px={8} py={4} mih={48} style={{ rowGap: 4 }}>
        <Group gap={2} wrap="nowrap">
          {icon(
            t("rehearse.toStart"),
            () => {
              seekSec(0);
            },
            <IconPlayerSkipBackFilled size={18} />,
          )}
          {prev}
          {icon(
            t("rehearse.back"),
            () => {
              skip(-5);
            },
            <IconRewindBackward5 size={20} />,
          )}
          {play}
          {icon(
            t("rehearse.forward"),
            () => {
              skip(5);
            },
            <IconRewindForward5 size={20} />,
          )}
          {next}
          {loop}
        </Group>
        <CountInCountdown />
        <Group gap={10} wrap="nowrap" align="baseline">
          <PositionText size="xl" />
          <BarBeatText size="lg" fw={500} />
          <MeterBox size="sm" />
        </Group>
        <SectionReadout size="md" />
        <TransportState />
        <Group gap={4} wrap="nowrap" ml="auto">
          <ClickToggles size={sizes.transport} />
          <PracticeButton size={sizes.transport} />
          {onRecord && <RecordButton onRecord={onRecord} size={sizes.transport} />}
          {options}
        </Group>
      </Group>
    );
  }

  // Sticky under the app header (SPEC §11.1, §31.1): opening the Mixer never moves it.
  return (
    <Box
      data-testid="rehearse-transport"
      data-layout={layout}
      role="region"
      aria-label={t("rehearse.controlBar")}
      style={{
        position: "sticky",
        top: "var(--app-shell-header-offset, 0px)",
        zIndex: 5,
        background: "var(--mantine-color-body)",
        borderBottom: "1px solid var(--mantine-color-default-border)",
        borderTopLeftRadius: "inherit",
        borderTopRightRadius: "inherit",
      }}
    >
      {interrupted}
      {startFailed}
      <Box role="toolbar" aria-label={t("rehearse.transportRow")} data-testid="transport-row">
        {row1}
      </Box>
      {editing ? editRow : contextRow}
      <ClickSettingsModal
        opened={clickSettings}
        onClose={() => {
          setClickSettingsOpen(false);
        }}
      />
      {layout !== "desktop" && <PracticeSheet />}
    </Box>
  );
}

/** "Editing · Saved" under the title (phones, landscape; SPEC §31.2). */
export function EditingLabel() {
  const { t } = useTranslation();
  const save = useEdit((s) => s.save);
  return (
    <Text
      size="xs"
      fw={700}
      c="orange"
      truncate="end"
      data-testid="edit-save-status"
      data-status={save}
    >
      {t("edit.editing_label")} ·{" "}
      <Text span size="xs" fw={500} c={save === "error" ? "red" : "dimmed"}>
        {t(`edit.save.${save}`)}
      </Text>
    </Text>
  );
}

/**
 * Row 2 of the control bar (SPEC §31.1): 32 px with 28 px icons on fine pointers, exactly 44 px
 * with 44 px buttons on touch screens. `edit`: the orange edit row.
 */
export function ContextRow({
  coarse,
  edit = false,
  spread = false,
  children,
  testId = "context-row",
  dataLayout,
  label,
}: {
  dataLayout?: string;
  coarse: boolean;
  edit?: boolean;
  /** Phones: the buttons spread over the width. */
  spread?: boolean;
  children: ReactNode;
  testId?: string;
  label: string;
}) {
  return (
    <Group
      role="toolbar"
      aria-label={label}
      gap={2}
      wrap={coarse ? "nowrap" : "wrap"}
      justify={spread ? "space-between" : undefined}
      px={coarse ? 4 : 8}
      py={coarse ? 0 : 2}
      data-testid={testId}
      data-layout={dataLayout}
      style={{
        boxSizing: "border-box",
        ...(coarse ? { height: 44 } : { minHeight: 32 }),
        background: edit
          ? "var(--mantine-color-orange-light)"
          : "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))",
        borderTop: edit
          ? "1px solid var(--mantine-color-orange-outline)"
          : "1px solid var(--mantine-color-default-border)",
        overflowX: coarse ? "auto" : undefined,
        scrollbarWidth: "none",
      }}
    >
      {children}
    </Group>
  );
}

/** A thin divider between the groups of row 2. */
export function RowDivider() {
  return <Divider orientation="vertical" mx={5} my="auto" h={16} />;
}

/** Zoom out, zoom in and fit the whole song (desktop row 2, SPEC §31.1). */
export function ZoomTools({ size }: { size: number }) {
  const { t } = useTranslation();
  const icon = Math.round(size * 0.55);
  const button = (label: string, onClick: () => void, child: ReactNode, testId: string) => (
    <Tooltip label={label}>
      <ActionIcon
        size={size}
        variant="subtle"
        color="gray"
        aria-label={label}
        onClick={onClick}
        data-testid={testId}
      >
        {child}
      </ActionIcon>
    </Tooltip>
  );
  const zoomOut = button(
    t("timeline.zoomOut"),
    () => {
      requestZoom(1 / 1.5);
    },
    <IconZoomOut size={icon} />,
    "zoom-out",
  );
  const zoomIn = button(
    t("timeline.zoomIn"),
    () => {
      requestZoom(1.5);
    },
    <IconZoomIn size={icon} />,
    "zoom-in",
  );
  const fit = button(
    t("timeline.fit"),
    requestFit,
    <IconArrowsHorizontal size={icon} />,
    "zoom-fit",
  );
  return (
    <Box
      role="group"
      aria-label={t("rehearse.zoomTools")}
      style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
    >
      {zoomOut}
      {zoomIn}
      {fit}
    </Box>
  );
}

/** Zoom in the phone and landscape "⋯". */
export function ZoomMenuItems() {
  const { t } = useTranslation();
  return (
    <>
      <Menu.Label>{t("rehearse.zoomTools")}</Menu.Label>
      <Menu.Item
        leftSection={<IconZoomOut size={14} />}
        onClick={() => {
          requestZoom(1 / 1.5);
        }}
        data-testid="zoom-out"
      >
        {t("timeline.zoomOut")}
      </Menu.Item>
      <Menu.Item
        leftSection={<IconZoomIn size={14} />}
        onClick={() => {
          requestZoom(1.5);
        }}
        data-testid="zoom-in"
      >
        {t("timeline.zoomIn")}
      </Menu.Item>
      <Menu.Item
        leftSection={<IconArrowsHorizontal size={14} />}
        onClick={requestFit}
        data-testid="zoom-fit"
      >
        {t("timeline.fit")}
      </Menu.Item>
    </>
  );
}

/** The transport's "⋯" (SPEC §11.3, §31.1): playback options, and on phones the other tools. */
function PlaybackMenu({
  layout,
  onBounce,
  onRecord,
  slots,
  moreItems,
  size,
  onClickSettings,
}: {
  layout: BarLayout;
  onBounce?: (() => void) | undefined;
  onRecord?: (() => void) | undefined;
  slots?: BarSongSlots | undefined;
  moreItems?: ReactNode;
  size: number;
  onClickSettings: () => void;
}) {
  const { t } = useTranslation();
  const quality = usePlayerView((s) => s.quality);
  const shownSong = usePlayerView((s) => s.songId);
  const editing = useEdit((s) => s.songId !== null && s.songId === shownSong);
  const prefs = usePlayerView((s) => s.prefs);
  const fallback = usePlayerView(
    (s) => s.quality === "lossless" && s.tracks.some((p) => p.chosen.quality !== "lossless"),
  );
  const snap = useTimelineUi((s) => s.snap);
  const hasTempo = useTempoUi((s) => s.grid !== null);
  const autoHidden = useChrome(chromeAutoOnly);
  const compact = layout !== "desktop";
  return (
    <Menu
      position="bottom-end"
      withinPortal
      closeOnItemClick={false}
      // On phones the menu is taller than the space below the sticky transport: it gets that
      // height and scrolls.
      middlewares={{ flip: true, shift: true, size: true }}
    >
      <Menu.Target>
        <Tooltip label={t("rehearse.options")}>
          <ActionIcon
            size={size}
            variant="subtle"
            color="gray"
            aria-label={t("rehearse.options")}
            data-testid="transport-more"
          >
            <IconDots size={20} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown miw={260} style={{ overflowY: "auto", overscrollBehavior: "contain" }}>
        {onBounce && (
          <>
            {/* First: the menu is long on phones, and the action must be reachable. */}
            <Menu.Item
              leftSection={<IconFileMusic size={14} />}
              closeMenuOnClick
              onClick={onBounce}
              data-testid="transport-bounce"
            >
              {t("bounce.action")}
            </Menu.Item>
            <Menu.Divider />
          </>
        )}
        {layout === "landscape" && slots && (
          <>
            {slots.mixer && (
              <Menu.Item
                leftSection={slots.mixer.open ? <IconCheck size={14} /> : <Box w={14} />}
                disabled={slots.mixer.disabled}
                onClick={slots.mixer.toggle}
                role="menuitemcheckbox"
                aria-checked={slots.mixer.open}
                data-testid="mixer-toggle"
              >
                {t("rehearse.mixer")}
              </Menu.Item>
            )}
            {slots.menuItems}
            {autoHidden && (
              <Menu.Item closeMenuOnClick onClick={showChrome} data-testid="chrome-show">
                {t("chrome.show")}
              </Menu.Item>
            )}
            <Menu.Divider />
          </>
        )}
        {compact && onRecord && (
          <>
            <Menu.Item
              leftSection={<IconMicrophone size={14} color="var(--mantine-color-red-filled)" />}
              closeMenuOnClick
              onClick={onRecord}
              data-testid="record-open"
            >
              {t("record.open")}
            </Menu.Item>
            <Menu.Divider />
          </>
        )}
        {/* Edit mode plays the session's clips (SPEC §24.6): no quality choice. */}
        {!editing && (
          <>
            <Menu.Label>
              {t("rehearse.quality.title")} ·{" "}
              {t("rehearse.quality.playing", { quality: t(`rehearse.quality.${quality}`) })}
              {fallback ? ` (${t("rehearse.quality.noLossless")})` : ""}
            </Menu.Label>
            {QUALITIES.map((q) => (
              <Menu.Item
                key={q}
                leftSection={prefs.quality === q ? <IconCheck size={14} /> : <Box w={14} />}
                onClick={() => {
                  setPrefs({ quality: q });
                }}
              >
                {t(`rehearse.quality.${q}`)}
              </Menu.Item>
            ))}
            <Menu.Item
              leftSection={prefs.preferLossless ? <IconCheck size={14} /> : <Box w={14} />}
              onClick={() => {
                setPrefs({ preferLossless: !prefs.preferLossless });
              }}
            >
              {t("rehearse.quality.preferLossless")}
            </Menu.Item>
          </>
        )}
        {compact && (
          <>
            <Menu.Divider />
            <PracticeMenuItem onOpen={openPracticeSheet} />
            <Menu.Divider />
            <ClickMenuItems onSettings={onClickSettings} />
            {moreItems && (
              <>
                <Menu.Divider />
                {moreItems}
              </>
            )}
            <Menu.Divider />
            <LaneMenuItems />
          </>
        )}
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconListDetails size={14} />}
          closeMenuOnClick
          onClick={() => {
            setItemsOpen(true);
          }}
          data-testid="transport-timeline-items"
        >
          {t("timelineItems.open")}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Label>{t("markers.snapTitle")}</Menu.Label>
        {SNAP_MODES.map((m) => (
          <Menu.Item
            key={m}
            disabled={!hasTempo && musicalSnap(m) !== null}
            leftSection={snap === m ? <IconCheck size={14} /> : <Box w={14} />}
            onClick={() => {
              setSnap(m);
            }}
          >
            {t(`markers.snap.${m}`)}
          </Menu.Item>
        ))}
        <Menu.Divider />
        <Menu.Label>{t("rehearse.wakeLock.title")}</Menu.Label>
        {WAKE.map((w) => (
          <Menu.Item
            key={w}
            leftSection={prefs.wakeLock === w ? <IconCheck size={14} /> : <Box w={14} />}
            onClick={() => {
              setPrefs({ wakeLock: w });
            }}
          >
            {t(`rehearse.wakeLock.${w}`)}
          </Menu.Item>
        ))}
        {!compact && (
          <>
            <Menu.Divider />
            <Menu.Item
              leftSection={<IconMetronome size={14} />}
              closeMenuOnClick
              disabled={!hasTempo}
              onClick={onClickSettings}
              data-testid="menu-click-settings"
            >
              {t("click.settings")}
            </Menu.Item>
            <Menu.Item
              leftSection={<IconKeyboard size={14} />}
              onClick={() => {
                setHelpOpen(true);
              }}
            >
              {t("shortcuts.open")}
            </Menu.Item>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
