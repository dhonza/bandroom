import { Box } from "@mantine/core";
import { useEffect, useRef } from "react";
import { subscribeMeters } from "./controller";

const FLOOR_DB = -60;

/**
 * The track headers show no peak meters for now (DECISIONS 2026-10-07). The meter and the engine's
 * meter reports stay, so turning this on brings them back.
 */
export const SHOW_METERS: boolean = false;

/** Linear peak → 0..1 on a dB scale (−60 dB … 0 dB). */
export function meterFraction(peak: number): number {
  if (peak <= 0) return 0;
  const db = 20 * Math.log10(peak);
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
}

/**
 * Peak meter (SPEC §11.3) fed by the engine at ~20 Hz. It writes the bar width directly to the
 * DOM with a short fall-off, so meters never re-render React.
 */
export function Meter({ trackId, label }: { trackId: string; label: string }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let level = 0;
    return subscribeMeters((m) => {
      const f = meterFraction(m.tracks[trackId] ?? 0);
      level = Math.max(f, level - 0.06);
      const el = bar.current;
      if (el) {
        el.style.width = `${(level * 100).toFixed(1)}%`;
        el.style.background =
          f >= 0.98 ? "var(--mantine-color-red-6)" : "var(--mantine-color-teal-6)";
      }
    });
  }, [trackId]);
  return (
    <Box
      h={4}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      style={{
        background: "var(--mantine-color-default-border)",
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      <Box ref={bar} h="100%" w={0} style={{ transition: "width 50ms linear" }} />
    </Box>
  );
}
