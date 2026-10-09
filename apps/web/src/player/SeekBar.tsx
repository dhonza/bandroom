import { Box, Group, Slider, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  playingDurationSec,
  playingPositionSec,
  seekPlayingSec,
  useRehearse,
} from "../rehearse/controller";
import { formatClock } from "./format";

/** How often the bar reads the engine position (its own re-render only, not the app's). */
const TICK_MS = 100;

/**
 * The engine song's position and length, read on animation frames at most every {@link TICK_MS}
 * (the position is not React state; a hidden tab does not tick).
 */
function usePlayhead(): { pos: number; dur: number } {
  const dormant = useRehearse((s) => s.dormant);
  const songId = useRehearse((s) => s.songId);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  useEffect(() => {
    let raf = 0;
    let last = -Infinity;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < TICK_MS) return;
      last = now;
      setDur(dormant ? 0 : playingDurationSec());
      setPos(dormant ? 0 : playingPositionSec());
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [dormant, songId]);
  return { pos: Math.min(pos, dur), dur };
}

/**
 * The player bar's seek slider (SPEC §6.10): drag or click to move in the playing song, arrow
 * keys step 5 s. `thin`: the phone's bar, a thin line without the times.
 */
export function SeekBar({ thin = false }: { thin?: boolean }) {
  const { t } = useTranslation();
  const { pos, dur } = usePlayhead();
  // While dragging the slider shows the finger; the song seeks when it is let go.
  const [drag, setDrag] = useState<number | null>(null);
  const latest = useRef<number | null>(null);
  const value = drag ?? pos;
  const slider = (
    <Slider
      value={value}
      min={0}
      max={Math.max(dur, 0.001)}
      step={0.1}
      disabled={dur <= 0}
      size={thin ? 3 : 4}
      thumbSize={thin ? 10 : 12}
      label={null}
      thumbLabel={t("listen.seek")}
      onChange={(v) => {
        latest.current = v;
        setDrag(v);
      }}
      // Mantine moves the value on an animation frame but may end a quick tap before it: the
      // seek waits a frame for the tapped value.
      onChangeEnd={(v) => {
        requestAnimationFrame(() => {
          seekPlayingSec(latest.current ?? v);
          latest.current = null;
          setDrag(null);
        });
      }}
      // Arrow keys step 5 s rather than the drag step.
      onKeyDownCapture={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        e.stopPropagation();
        seekPlayingSec(value + (e.key === "ArrowRight" ? 5 : -5));
      }}
      data-testid="mini-seek"
      style={{ flex: 1 }}
    />
  );
  if (thin) {
    return (
      <Box px={6} py={3}>
        {slider}
      </Box>
    );
  }
  return (
    <Group gap="xs" wrap="nowrap">
      <Text
        size="xs"
        c="dimmed"
        className="tabular-nums"
        w={40}
        ta="right"
        data-testid="mini-elapsed"
      >
        {formatClock(value, false)}
      </Text>
      {slider}
      <Text size="xs" c="dimmed" className="tabular-nums" w={40} data-testid="mini-duration">
        {formatClock(dur, false)}
      </Text>
    </Group>
  );
}
