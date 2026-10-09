import { formatMeter, secToBarBeat, tempoAt, type TempoGrid } from "@bandroom/shared";
import { Text, type TextProps } from "@mantine/core";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { positionNow } from "../markers/store";
import { useTempoUi } from "./store";

/** "17.3", or "pickup 3" in bars before bar 1 (SPEC §7.1). */
export function barBeatLabel(
  grid: TempoGrid,
  sec: number,
  pickup: (beat: number) => string,
): string {
  const bb = secToBarBeat(grid, sec);
  return bb.bar <= 0 ? pickup(bb.beat) : `${bb.bar}.${bb.beat}`;
}

/** The time signature at `sec` ("7/8"). */
export function meterLabel(grid: TempoGrid, sec: number): string {
  return formatMeter(tempoAt(grid, sec).meter);
}

/**
 * Bar.beat of the playhead ("17.3", SPEC §11.3 readouts), updated every animation frame in the
 * DOM without React re-renders. Renders nothing without a tempo map.
 */
export function BarBeatText(props: TextProps & { getPosition?: () => number }) {
  const { t } = useTranslation();
  const grid = useTempoUi((s) => s.grid);
  const ref = useRef<HTMLSpanElement>(null);
  const { getPosition = positionNow, ...rest } = props;
  useEffect(() => {
    if (!grid) return;
    let raf = 0;
    let last = "";
    const tick = () => {
      const text = barBeatLabel(grid, getPosition(), (beat) => t("tempo.pickup", { beat }));
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
  }, [grid, getPosition, t]);
  if (!grid) return null;
  return (
    <Text
      component="span"
      ref={ref}
      fw={700}
      className="tabular-nums"
      data-testid="bar-beat"
      aria-label={t("tempo.barBeat")}
      {...rest}
    />
  );
}

/**
 * The time signature at the playhead ("7/8", SPEC §11.3 readouts), next to the bar.beat readout.
 * Updated every animation frame in the DOM, written only when it changes. Renders nothing without
 * a tempo map.
 */
export function MeterText(props: TextProps & { getPosition?: () => number }) {
  const { t } = useTranslation();
  const grid = useTempoUi((s) => s.grid);
  const ref = useRef<HTMLSpanElement>(null);
  const { getPosition = positionNow, ...rest } = props;
  useEffect(() => {
    if (!grid) return;
    let raf = 0;
    let last = "";
    const tick = () => {
      const text = meterLabel(grid, getPosition());
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
  }, [grid, getPosition]);
  if (!grid) return null;
  return (
    <Text
      component="span"
      ref={ref}
      className="tabular-nums"
      data-testid="meter-readout"
      aria-label={t("tempo.meterNow")}
      {...rest}
    />
  );
}
