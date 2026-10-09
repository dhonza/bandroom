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
 * The time-signature lane (SPEC §11.3): the first top lane, a label such as "4/4" at each meter
 * change. Editors tap one to open the tempo dialog; for others a tap seeks like the ruler.
 */
export function SignatureLane({
  view,
  grid,
  top,
  height,
  onOpen,
}: {
  view: View;
  grid: TempoGrid;
  top: number;
  height: number;
  /** Opens the tempo dialog (editors only); a tap arrives as `onItemTap` of the timeline. */
  onOpen: (() => void) | null;
}) {
  const editable = onOpen !== null;
  const { t } = useTranslation();
  return (
    <>
      {signatureMarks(grid).map((s, i) => {
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
              left: x,
              top,
              height,
              minWidth: editable ? 44 : undefined,
              display: "flex",
              alignItems: "center",
              paddingLeft: 4,
              borderLeft: "2px solid var(--mantine-color-dimmed)",
              pointerEvents: editable ? "auto" : "none",
              cursor: editable ? "pointer" : undefined,
              touchAction: "pan-y",
            }}
          >
            <Text size="xs" fw={700} lh={1.1} c="dimmed" className="tabular-nums">
              {s.label}
            </Text>
          </Box>
        );
      })}
    </>
  );
}
