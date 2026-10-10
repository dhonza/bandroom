import { Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { sectionAt } from "./model";
import { positionNow, useTimelineUi } from "./store";

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
