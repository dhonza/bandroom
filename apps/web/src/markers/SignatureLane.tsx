import { beatToSec, formatMeter, type TempoGrid } from "@bandroom/shared";
import { Box, Text } from "@mantine/core";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { secToX, type View } from "../timeline/view";

/** Prefix of signature ids in `data-timeline-item` (taps arrive via the timeline's onItemTap). */
export const SIGNATURE_ITEM_PREFIX = "signature:";

export interface SignatureMark {
  /** Song seconds of the bar where the meter starts. */
  sec: number;
  /** 1-based bar number. */
  bar: number;
  label: string;
}

/** Where the meter changes (including bar 1), from the compiled tempo map (SPEC §7.1). */
export function signatureMarks(grid: TempoGrid): SignatureMark[] {
  return grid.regions.map((r) => ({
    sec: beatToSec(grid, r.startBeat),
    bar: r.startBar + 1,
    label: formatMeter(r.meter),
  }));
}

/**
 * The meter changes after bar 1 (SPEC §31.4): what the ruler shows. Nothing when the song keeps
 * one meter; a new bar in the same meter is no change.
 */
export function meterChangeMarks(grid: TempoGrid): (SignatureMark & { index: number })[] {
  const marks = signatureMarks(grid);
  return marks
    .map((m, index) => ({ ...m, index }))
    .filter((m, i) => i > 0 && m.label !== marks[i - 1]?.label);
}

/**
 * Meter changes on the ruler (SPEC §31.4): a boxed "7/8" at each change. Editors tap one to open
 * the tempo dialog; for others a tap seeks like the ruler.
 */
export function RulerMeters({
  view,
  grid,
  height,
  onOpen,
}: {
  view: View;
  grid: TempoGrid;
  /** The ruler's height. */
  height: number;
  /** Opens the tempo dialog (editors only); a tap arrives as `onItemTap` of the timeline. */
  onOpen: (() => void) | null;
}) {
  const editable = onOpen !== null;
  const { t } = useTranslation();
  return (
    <>
      {meterChangeMarks(grid).map((s) => {
        const i = s.index;
        const x = secToX(view, s.sec);
        if (x < -80 || x > view.widthPx + 2) return null;
        return (
          <Box
            key={`${String(i)}:${s.label}`}
            data-testid="signature-item"
            data-x={Math.round(x)}
            aria-label={t("markers.signatureLabel", { meter: s.label, bar: s.bar })}
            {...(editable && {
              role: "button",
              tabIndex: 0,
              "data-timeline-item": `${SIGNATURE_ITEM_PREFIX}${String(i)}`,
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  e.stopPropagation();
                  onOpen();
                }
              },
            })}
            style={{
              position: "absolute",
              left: x + 2,
              top: 0,
              height,
              minWidth: editable && height >= 36 ? 44 : undefined,
              display: "flex",
              alignItems: "center",
              pointerEvents: editable ? "auto" : "none",
              cursor: editable ? "pointer" : undefined,
              touchAction: "pan-y",
            }}
          >
            <Text
              component="span"
              size="10px"
              fw={700}
              lh="12px"
              px={3}
              className="tabular-nums"
              style={{
                border: "1px solid var(--mantine-color-default-border)",
                borderRadius: 3,
                background: "var(--mantine-color-body)",
                pointerEvents: "none",
              }}
            >
              {s.label}
            </Text>
          </Box>
        );
      })}
    </>
  );
}
