import { Box } from "@mantine/core";
import { useMemo } from "react";

/** Mini waveform from the 1024-point overview (SPEC §5.3 step 8) as a lightweight SVG. */
export function OverviewWave({
  overview,
  color,
  bars = 120,
  height = 32,
}: {
  overview: number[];
  color: string;
  bars?: number;
  height?: number;
}) {
  const values = useMemo(() => {
    if (overview.length === 0) return [];
    const out: number[] = [];
    const step = overview.length / bars;
    for (let i = 0; i < bars; i++) {
      let m = 0;
      for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++)
        m = Math.max(m, overview[j] ?? 0);
      out.push(m / 127);
    }
    return out;
  }, [overview, bars]);
  if (values.length === 0) return null;
  return (
    <Box
      component="svg"
      viewBox={`0 0 ${bars} 100`}
      preserveAspectRatio="none"
      h={height}
      w="100%"
      aria-hidden
      style={{ display: "block" }}
    >
      {values.map((v, i) => {
        const h = Math.max(2, v * 100);
        return (
          <rect
            key={i}
            x={i + 0.15}
            y={(100 - h) / 2}
            width={0.7}
            height={h}
            fill={`var(--mantine-color-${color}-5)`}
            opacity={0.75}
          />
        );
      })}
    </Box>
  );
}
