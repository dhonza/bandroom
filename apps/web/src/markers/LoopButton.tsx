import { ActionIcon, Box, Menu, Tooltip } from "@mantine/core";
import { IconRepeat } from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LONG_PRESS_MS } from "../lib/gestures";
import { MenuAnchor } from "./MenuAnchor";
import { useCurrentSectionId } from "./SectionReadout";
import { canToggleLoop, positionNow, toggleLoop, useTimelineUi } from "./store";

/**
 * The loop toggle with its disabled state (nothing to loop). Long-press (or right-click) opens
 * the loop options (SPEC §11.3), e.g. "count-in every repeat".
 */
export function LoopButton({ size = 44, options }: { size?: number; options?: ReactNode }) {
  const { t } = useTranslation();
  const state = useTimelineUi();
  const current = useCurrentSectionId(); // re-renders when the playhead enters or leaves one
  const enabled = canToggleLoop(state, positionNow()) || current !== null;
  const [menu, setMenu] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const downAt = useRef(0);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const button = (
    <ActionIcon
      size={size}
      variant={state.loopOn ? "filled" : "subtle"}
      color={state.loopOn ? "yellow" : "gray"}
      disabled={!enabled && !options}
      data-disabled={!enabled || undefined}
      aria-disabled={!enabled}
      aria-label={t("markers.loop")}
      aria-pressed={state.loopOn}
      aria-haspopup={options ? "menu" : undefined}
      onPointerDown={(e) => {
        longPressed.current = false;
        downAt.current = e.timeStamp;
        if (!options) return;
        clear();
        timer.current = setTimeout(() => {
          longPressed.current = true;
          setMenu(true);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={(e) => {
        clear();
        // A short press is a click even when a busy main thread ran the timer first.
        if (longPressed.current && e.timeStamp - downAt.current < LONG_PRESS_MS) {
          longPressed.current = false;
          setMenu(false);
        }
      }}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onContextMenu={(e) => {
        if (!options) return;
        e.preventDefault();
        clear();
        setMenu(true);
      }}
      onClick={() => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        if (enabled) toggleLoop();
      }}
      style={{ touchAction: "manipulation", WebkitTouchCallout: "none", userSelect: "none" }}
      data-testid="loop-toggle"
    >
      <IconRepeat size={20} />
    </ActionIcon>
  );
  if (!options) {
    return (
      <Tooltip label={enabled ? t("markers.loop") : t("markers.loopDisabled")}>{button}</Tooltip>
    );
  }
  // The menu has its own invisible anchor so a plain click still toggles the loop.
  return (
    <Box pos="relative" style={{ display: "inline-flex" }}>
      <Tooltip
        label={enabled ? t("markers.loopWithOptions") : t("markers.loopDisabled")}
        disabled={menu}
      >
        {button}
      </Tooltip>
      <Menu
        opened={menu}
        onChange={setMenu}
        position="top-start"
        withinPortal
        closeOnItemClick={false}
      >
        <Menu.Target>
          {/* Menu.Target adds aria-haspopup/aria-expanded, which need a button role; the anchor
              itself is hidden from assistive tech (the loop button above announces the menu). */}
          <MenuAnchor
            pos="absolute"
            left={0}
            top={0}
            w={size}
            h={size}
            style={{ pointerEvents: "none" }}
          />
        </Menu.Target>
        <Menu.Dropdown data-testid="loop-options">
          <Menu.Label>{t("markers.loopOptions")}</Menu.Label>
          {options}
        </Menu.Dropdown>
      </Menu>
    </Box>
  );
}
