import { Box } from "@mantine/core";
import { useEffect, useRef } from "react";
import { subscribeMeters } from "./controller";

const FLOOR_DB = -60;
/** How far the bar falls per report (~20 Hz): from full to zero in under a second. */
const FALL_OFF = 0.06;
/** The vertical meter's width on short track headers. */
export const VERTICAL_METER_W = 4;

/** Linear peak → 0..1 on a dB scale (−60 dB … 0 dB). */
export function meterFraction(peak: number): number {
  if (peak <= 0) return 0;
  const db = 20 * Math.log10(peak);
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
}

/**
 * Post-fader peak meter (SPEC §11.3) fed by the engine at ~20 Hz: a horizontal bar on full track
 * headers, a thin vertical one filling bottom-up along the edge of shorter headers. It writes the
 * bar size directly to the DOM with a short fall-off, so meters never re-render React.
 */
export function Meter({
  trackId,
  label,
  vertical = false,
}: {
  trackId: string;
  label: string;
  vertical?: boolean;
}) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let level = 0;
    return subscribeMeters((m) => {
      const f = meterFraction(m.tracks[trackId] ?? 0);
      level = Math.max(f, level - FALL_OFF);
      const el = bar.current;
      if (el) {
        const size = `${(level * 100).toFixed(1)}%`;
        if (vertical) el.style.height = size;
        else el.style.width = size;
        el.style.background =
          f >= 0.98 ? "var(--mantine-color-red-6)" : "var(--mantine-color-teal-6)";
      }
    });
  }, [trackId, vertical]);
  return (
    <Box
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      data-testid="track-meter"
      data-orientation={vertical ? "vertical" : "horizontal"}
      style={{
        background: "var(--mantine-color-default-border)",
        borderRadius: 2,
        overflow: "hidden",
        ...(vertical
          ? {
              flex: "none",
              width: VERTICAL_METER_W,
              position: "relative",
              // Clear of the 2 px buffer line along the header's bottom.
              marginBottom: 2,
            }
          : { height: 4 }),
      }}
    >
      <Box
        ref={bar}
        data-testid="track-meter-bar"
        style={
          vertical
            ? {
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 0,
                transition: "height 50ms linear",
              }
            : { height: "100%", width: 0, transition: "width 50ms linear" }
        }
      />
    </Box>
  );
}
