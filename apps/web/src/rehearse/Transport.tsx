import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Menu,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCheck,
  IconDots,
  IconFileMusic,
  IconKeyboard,
  IconListDetails,
  IconMicrophone,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBackFilled,
  IconPlayerTrackNextFilled,
  IconPlayerTrackPrevFilled,
  IconRewindBackward5,
  IconRewindForward5,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import {
  openPracticeSheet,
  PracticeButton,
  PracticeMenuItem,
  PracticeSheet,
} from "./PracticeControls";
import { useTranslation } from "react-i18next";
import { formatClock } from "../player/format";
import { musicalSnap, SNAP_MODES } from "../markers/model";
import { BarBeatText, MeterText } from "../tempo/readout";
import { useTempoUi } from "../tempo/store";
import {
  ClickMenuItems,
  ClickSettingsModal,
  ClickToggles,
  CountInCountdown,
  LoopCountInOptions,
} from "./ClickControls";
import { LaneMenuItems } from "../markers/LanesMenu";
import { LoopButton, SectionReadout } from "../markers/SongMarkers";
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

const QUALITIES: QualityPref[] = ["auto", "lossless", "high", "low"];
/** Shown instead of the song length while it runs until Stop (not text to translate). */
const NO_END = "–:––";
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

/** Opens the record sheet (SPEC §9): in the transport on desktop, the readout row on phones. */
export function RecordButton({ onRecord }: { onRecord: () => void }) {
  const { t } = useTranslation();
  return (
    <Tooltip label={t("record.open")}>
      <ActionIcon
        size={44}
        variant="subtle"
        color="red"
        aria-label={t("record.open")}
        onClick={onRecord}
        data-testid="record-open"
      >
        <IconMicrophone size={22} color="var(--mantine-color-red-filled)" />
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
 * The Player's transport (SPEC §11.1, §11.3): at the top of the Player in both Mixer states,
 * sticky under the app header. Desktop and tablet: start, previous, −5 s, play/pause, +5 s, next,
 * loop, the position readout, count-in, click, click settings and "⋯" (quality, snap, keep screen
 * on). Phones: loop, previous, play/pause, next, the position and "⋯", which also holds click and
 * count-in.
 */
export function Transport({
  phone,
  onBounce,
  onRecord,
}: {
  phone: boolean;
  /** Opens "Bounce to new song…" (SPEC §5.5); absent when the user may not bounce. */
  onBounce?: (() => void) | undefined;
  /** Opens the record sheet (SPEC §9); absent when the user may not record here. */
  onRecord?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const status = usePlayerView((s) => s.status);
  const quality = usePlayerView((s) => s.quality);
  const prefs = usePlayerView((s) => s.prefs);
  const fallback = usePlayerView(
    (s) => s.quality === "lossless" && s.tracks.some((p) => p.chosen.quality !== "lossless"),
  );
  const playing = status === "playing" || status === "buffering";
  const duration = usePlayerView((s) => s.lengthSec);
  // An empty song runs until Stop (SPEC §9): no song length to show.
  const noEnd = usePlayerView((s) => s.openEnd && s.lengthSec === 0);

  const snap = useTimelineUi((s) => s.snap);
  const hasTempo = useTempoUi((s) => s.grid !== null);
  const [clickSettings, setClickSettingsOpen] = useState(false);
  const loop = <LoopButton options={<LoopCountInOptions />} />;
  const icon = (label: string, onClick: () => void, child: React.ReactNode, testId?: string) => (
    <ActionIcon
      size={44}
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
      size={56}
      radius="xl"
      variant="filled"
      onClick={playPause}
      disabled={status === "idle"}
      aria-label={playing ? t("listen.pause") : t("listen.play")}
      data-testid="rehearse-play"
    >
      {playing ? <IconPlayerPauseFilled size={26} /> : <IconPlayerPlayFilled size={26} />}
    </ActionIcon>
  );
  const prev = icon(t("markers.prev"), goPrev, <IconPlayerTrackPrevFilled size={20} />, "go-prev");
  const next = icon(t("markers.next"), goNext, <IconPlayerTrackNextFilled size={20} />, "go-next");
  // Phone (SPEC §11.3): ⟲ |◀◀ ▶/❚❚ ▶▶| 0:49 ⋯ — the rest sits in "⋯" and on the page.
  const buttons = phone ? (
    <Group gap={4} wrap="nowrap">
      {loop}
      {prev}
      {play}
      {next}
    </Group>
  ) : (
    <Group gap={4} wrap="nowrap">
      {icon(
        t("rehearse.toStart"),
        () => {
          seekSec(0);
        },
        <IconPlayerSkipBackFilled size={20} />,
      )}
      {prev}
      {icon(
        t("rehearse.back"),
        () => {
          skip(-5);
        },
        <IconRewindBackward5 size={22} />,
      )}
      {play}
      {icon(
        t("rehearse.forward"),
        () => {
          skip(5);
        },
        <IconRewindForward5 size={22} />,
      )}
      {next}
      {loop}
    </Group>
  );

  const state = <TransportState />;

  const options = (
    <Menu
      position="bottom-end"
      withinPortal
      closeOnItemClick={false}
      // On phones the menu is taller than the space below the sticky transport: it gets that
      // height and scrolls.
      middlewares={{ flip: true, shift: true, size: true }}
    >
      <Menu.Target>
        <ActionIcon size={44} variant="subtle" color="gray" aria-label={t("rehearse.options")}>
          <IconDots size={20} />
        </ActionIcon>
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
        {phone && (
          <>
            <Menu.Divider />
            <PracticeMenuItem onOpen={openPracticeSheet} />
            <Menu.Divider />
            <ClickMenuItems
              onSettings={() => {
                setClickSettingsOpen(true);
              }}
            />
            {/* The timeline corner is narrow on phones: the lanes menu is here too. */}
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
        {!phone && (
          <>
            <Menu.Divider />
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

  const interrupted = status === "interrupted" && (
    <Text size="sm" c="orange" data-testid="rehearse-interrupted">
      {t("rehearse.interrupted")}
    </Text>
  );
  const startFailed = status === "error" && (
    <Group gap="xs" wrap="wrap" data-testid="rehearse-start-failed">
      <Text size="sm" c="red">
        {t("rehearse.startFailed")}
      </Text>
      <Button size="compact-md" mih={44} variant="light" onClick={retryAudio}>
        {t("common.retry")}
      </Button>
    </Group>
  );

  // Sticky under the app header (SPEC §11.1): opening the Mixer never moves it.
  const sticky = {
    position: "sticky",
    top: "var(--app-shell-header-offset, 0px)",
    zIndex: 5,
    background: "var(--mantine-color-body)",
    borderBottom: "1px solid var(--mantine-color-default-border)",
  } as const;

  if (phone) {
    return (
      <Box
        data-testid="rehearse-transport"
        px={4}
        py={6}
        style={{ ...sticky, marginInline: "calc(var(--mantine-spacing-md) * -1)" }}
      >
        {interrupted}
        {startFailed}
        <Group justify="space-between" wrap="nowrap" gap={4}>
          {buttons}
          <Box style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textAlign: "center" }}>
            <PositionText size="lg" withMs={false} />
          </Box>
          {options}
        </Group>
        <ClickSettingsModal
          opened={clickSettings}
          onClose={() => {
            setClickSettingsOpen(false);
          }}
        />
        <PracticeSheet />
      </Box>
    );
  }
  return (
    <Box data-testid="rehearse-transport" py="xs" style={sticky}>
      {interrupted}
      {startFailed}
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap="lg" wrap="wrap" style={{ rowGap: 4 }}>
          {buttons}
          <CountInCountdown />
          <Stack gap={0}>
            <Group gap="xs" wrap="nowrap">
              <PositionText size="xl" />
              <BarBeatText size="xl" c="dimmed" />
              <MeterText size="md" c="dimmed" />
            </Group>
            {/* Kept when there is no end (the row keeps its height when tracks arrive). */}
            <Text size="xs" c="dimmed" className="tabular-nums">
              {noEnd ? NO_END : formatClock(duration, false)}
            </Text>
          </Stack>
          <SectionReadout />
          {state}
        </Group>
        <Group gap={4} wrap="nowrap">
          {onRecord && <RecordButton onRecord={onRecord} />}
          <PracticeButton />
          <ClickToggles />
          {options}
        </Group>
      </Group>
    </Box>
  );
}
