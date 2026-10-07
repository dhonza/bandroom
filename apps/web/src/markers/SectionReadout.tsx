import { Button, Group, ScrollArea, Text } from "@mantine/core";
import { IconRepeat } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { isDoubleTap, sectionAt, sectionsOf } from "./model";
import { effectiveLoop, loopSection, positionNow, seekTo, useTimelineUi } from "./store";

/** Current section (and loop state) under the playhead, updated per frame. */
export function useCurrentSectionId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let raf = 0;
    let last: string | null = null;
    const tick = () => {
      const s = sectionAt(useTimelineUi.getState().markers, positionNow());
      const next = s?.id ?? null;
      if (next !== last) {
        last = next;
        setId(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, []);
  return id;
}

/** Big readout of the section under the playhead ("CHORUS 2", SPEC §11.1). */
export function SectionReadout({ size = "lg" }: { size?: "lg" | "xl" }) {
  const id = useCurrentSectionId();
  const markers = useTimelineUi((s) => s.markers);
  const m = markers.find((x) => x.id === id);
  if (!m) return null;
  return (
    <Text
      size={size}
      fw={800}
      tt="uppercase"
      c={`var(--mantine-color-${m.color}-light-color)`}
      truncate
      data-testid="section-readout"
    >
      {m.name}
    </Text>
  );
}

let lastChipTap: { id: string; at: number } | null = null;

/** Section chips: tap = jump to the section, double tap = loop it (SPEC §11.3, two-tap rule). */
export function SectionChips() {
  const { t } = useTranslation();
  const markers = useTimelineUi((s) => s.markers);
  const loop = useTimelineUi((s) => effectiveLoop(s));
  const current = useCurrentSectionId();
  const sections = useMemo(() => sectionsOf(markers), [markers]);
  if (sections.length === 0) return null;
  return (
    <ScrollArea type="never" offsetScrollbars={false} data-testid="section-chips">
      <Group gap={8} wrap="nowrap" py={2}>
        {sections.map((s) => {
          const looped = loop !== null && loop.start === s.startSec && loop.end === s.endSec;
          return (
            <Button
              key={s.id}
              size="sm"
              h={44}
              radius="xl"
              variant={looped ? "filled" : current === s.id ? "light" : "default"}
              color={s.color}
              leftSection={looped ? <IconRepeat size={14} /> : undefined}
              style={{ flex: "none", touchAction: "manipulation" }}
              data-testid="section-chip"
              data-looped={looped || undefined}
              aria-label={t("markers.chipLabel", { name: s.name })}
              onDoubleClick={() => {
                loopSection(s);
              }}
              onClick={() => {
                const now = Date.now();
                if (isDoubleTap(lastChipTap, s.id, now)) {
                  lastChipTap = null;
                  loopSection(s);
                } else {
                  lastChipTap = { id: s.id, at: now };
                  seekTo(s.startSec);
                }
              }}
            >
              {s.name}
            </Button>
          );
        })}
      </Group>
    </ScrollArea>
  );
}
