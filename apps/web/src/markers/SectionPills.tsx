import type { Song } from "@bandroom/shared";
import { ActionIcon, Group, Tooltip, UnstyledButton } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconChevronUp, IconPlus, IconRepeat } from "@tabler/icons-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useOptionalUser } from "../auth/session";
import { COARSE_POINTER_QUERY } from "../shell/mediaQueries";
import { addSectionFromSelection } from "./actions";
import { isDoubleTap, isLoopable, sectionsOf } from "./model";
import { useMarkerPermissions } from "./queries";
import { useCurrentSectionId } from "./SectionReadout";
import { setSectionPills, toggleSectionPills, useSectionPillsOn } from "./pillsStore";
import { effectiveLoop, loopSection, seekTo, useTimelineUi } from "./store";

/** Link visitors have no account: they share one key on the device. */
const NO_USER = "link";

/** The key the section pills choice is stored under (SPEC §31.3). */
export function usePillsUserId(): string {
  return useOptionalUser()?.id ?? NO_USER;
}

/** Whether this user has the section pills on (on this device). */
export function usePillsOn(): boolean {
  return useSectionPillsOn(usePillsUserId());
}

/** Shows or hides the pills for the current user. */
export function useTogglePills(): () => void {
  const userId = usePillsUserId();
  return () => {
    toggleSectionPills(userId);
  };
}

/** The section pills icon (SPEC §31.3): four pills on two rows. */
export function PillsIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "none" }}
    >
      <path d="M3 5h8v5H3z M13 5h8v5h-8z M3 14h5v5H3z M10 14h11v5H10z" />
    </svg>
  );
}

let lastTap: { id: string; at: number } | null = null;

/**
 * Section pills (SPEC §31.3): text-width, wrapping, a 2 px top border in the section colour;
 * 22 px tall with a mouse, 34 px on touch (exempt from the 44 px rule). Tap = jump to the section,
 * double tap = loop it; "+" adds a section from the selection, "⌃" hides the pills. Renders only
 * while the user has them on.
 */
export function SectionPills({ song }: { song: Song }) {
  const { t } = useTranslation();
  const userId = usePillsUserId();
  const on = useSectionPillsOn(userId);
  const coarse = useMediaQuery(COARSE_POINTER_QUERY, false, { getInitialValueInEffect: false });
  const markers = useTimelineUi((s) => s.markers);
  const loop = useTimelineUi((s) => effectiveLoop(s));
  const selection = useTimelineUi((s) => s.selection);
  const current = useCurrentSectionId();
  const sections = useMemo(() => sectionsOf(markers), [markers]);
  const { mayCreate, locked } = useMarkerPermissions(song);
  if (!on) return null;
  const h = coarse ? 34 : 22;
  return (
    <Group
      gap={3}
      wrap="nowrap"
      align="flex-start"
      px={8}
      py={4}
      role="group"
      aria-label={t("markers.pills.row")}
      data-testid="section-pills"
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
    >
      <Group gap={3} wrap="wrap" style={{ flex: "1 1 auto", minWidth: 0 }}>
        {sections.map((s) => {
          const looped = loop !== null && loop.start === s.startSec && loop.end === s.endSec;
          const here = current === s.id;
          return (
            <UnstyledButton
              key={s.id}
              px={coarse ? 8 : 7}
              data-touch-exempt
              data-testid="section-chip"
              data-looped={looped || undefined}
              data-current={here || undefined}
              aria-label={t("markers.chipLabel", { name: s.name })}
              onDoubleClick={() => {
                loopSection(s);
              }}
              onClick={() => {
                const now = Date.now();
                if (isDoubleTap(lastTap, s.id, now)) {
                  lastTap = null;
                  loopSection(s);
                } else {
                  lastTap = { id: s.id, at: now };
                  seekTo(s.startSec);
                }
              }}
              style={{
                height: h,
                flex: coarse ? "1 0 auto" : "none",
                minWidth: coarse ? 52 : 56,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                boxSizing: "border-box",
                borderRadius: 4,
                borderTop: `2px solid var(--mantine-color-${s.color}-filled)`,
                background: looped
                  ? "var(--mantine-color-yellow-filled)"
                  : here
                    ? "var(--mantine-color-default-hover)"
                    : "var(--mantine-color-default)",
                color: looped ? "var(--mantine-color-black)" : "var(--mantine-color-text)",
                fontSize: coarse ? 12 : 11.5,
                fontWeight: 600,
                whiteSpace: "nowrap",
                touchAction: "manipulation",
              }}
            >
              {s.name}
              {looped && <IconRepeat size={coarse ? 13 : 12} stroke={2.5} aria-hidden />}
            </UnstyledButton>
          );
        })}
        {mayCreate && (
          <Tooltip
            label={isLoopable(selection) ? t("markers.pills.add") : t("markers.addSectionHint")}
          >
            <ActionIcon
              size={h}
              variant="default"
              data-touch-exempt
              disabled={locked || !selection}
              aria-label={t("markers.pills.add")}
              onClick={() => {
                addSectionFromSelection();
              }}
              data-testid="pills-add-section"
              style={{ borderStyle: "dashed" }}
            >
              <IconPlus size={14} stroke={2.5} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
      <Tooltip label={t("markers.pills.hide")}>
        <ActionIcon
          size={h}
          variant="subtle"
          color="gray"
          data-touch-exempt
          aria-label={t("markers.pills.hide")}
          onClick={() => {
            setSectionPills(userId, false);
          }}
          data-testid="section-pills-hide"
        >
          <IconChevronUp size={16} stroke={2.5} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
