import { clickAudible } from "@bandroom/shared";
import { ActionIcon, Box, Group, Slider, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconAdjustmentsHorizontal, IconMetronome } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelPopover } from "../components/ResponsivePanel";
import { trackTint } from "../timeline/render";
import { ClickSettingsForm, useClickSettings } from "./ClickControls";
import { setClickSettings, usePlayerView } from "./controller";
import { headerButtonSize, headerTier } from "./headerTier";

/** The click lane's colour (SPEC §11.3): grape, like the transport's Click toggle. */
export const CLICK_LANE_COLOR = "grape";
/** The click volume's range, as in the click settings (SPEC §6.7). */
export const CLICK_FADER_MIN = -40;
export const CLICK_FADER_MAX = 6;

/**
 * The click's header in the Mixer (SPEC §11.3, DECISIONS 2026-10-07), laid out like a track's
 * (`headerTier`): name, M, S, a fader for the click volume and ⚙ with the click settings. It is
 * the same personal state as the transport's Click toggle and ⚙: M is the click switched off, S
 * the click solo (SPEC §6.6), the fader `click.gainDb`.
 */
export function ClickStrip({ height, compact = false }: { height: number; compact?: boolean }) {
  const { t } = useTranslation();
  const c = useClickSettings();
  const audible = usePlayerView((s) => clickAudible(s.mix));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const tier = headerTier(height, compact);
  const btn = headerButtonSize(height, compact);
  const inlineFader = !compact && tier !== "one";
  const name = t("click.click");
  const muted = !c.enabled;

  const nameText = (
    <Text
      size={tier === "full" ? "sm" : "xs"}
      fw={600}
      lh={tier === "full" ? undefined : "16px"}
      truncate
      c={audible ? undefined : "dimmed"}
      style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 4 }}
    >
      <IconMetronome size={14} style={{ flex: "none" }} />
      {name}
    </Text>
  );

  const buttons = (
    <>
      <ActionIcon
        size={btn}
        variant={muted ? "filled" : "default"}
        color={muted ? "red" : "gray"}
        aria-pressed={muted}
        aria-label={t("click.mute")}
        onClick={() => {
          setClickSettings({ enabled: muted });
        }}
        data-testid="click-mute"
      >
        <Text fw={700} size={btn < 32 ? "xs" : "sm"}>
          {t("rehearse.mute")}
        </Text>
      </ActionIcon>
      <ActionIcon
        size={btn}
        variant={c.solo ? "filled" : "default"}
        color={c.solo ? "yellow" : "gray"}
        aria-pressed={c.solo}
        aria-label={t("click.solo")}
        onClick={() => {
          setClickSettings({ solo: !c.solo });
        }}
        data-testid="click-solo"
      >
        <Text fw={700} size={btn < 32 ? "xs" : "sm"} c={c.solo ? "dark" : undefined}>
          {t("rehearse.solo")}
        </Text>
      </ActionIcon>
    </>
  );

  const fader = (
    <Slider
      style={{ flex: 1, minWidth: 80 }}
      min={CLICK_FADER_MIN}
      max={CLICK_FADER_MAX}
      step={1}
      value={Math.max(CLICK_FADER_MIN, c.gainDb)}
      onChange={(v) => {
        setClickSettings({ gainDb: v });
      }}
      label={(v) => t("rehearse.db", { value: v > 0 ? `+${v}` : String(v) })}
      thumbSize={20}
      color={CLICK_LANE_COLOR}
      thumbLabel={t("click.volume")}
      data-testid="click-fader"
    />
  );

  const settingsLabel = t("click.settings");
  const toggleSettings = () => {
    setSettingsOpen((o) => !o);
  };
  // Narrow headers: the whole header (behind M/S) opens the settings, as on track headers.
  const target = compact ? (
    <UnstyledButton
      onClick={toggleSettings}
      aria-label={settingsLabel}
      aria-haspopup="dialog"
      aria-expanded={settingsOpen}
      data-testid="click-strip-settings"
      pos="absolute"
      inset={0}
      px={4}
      py={tier === "one" ? 0 : 2}
      style={{ display: "flex", alignItems: tier === "one" ? "center" : "flex-start" }}
    >
      <Box
        style={{ minWidth: 0, maxWidth: tier === "one" ? `calc(100% - ${2 * btn + 6}px)` : "100%" }}
      >
        {nameText}
      </Box>
    </UnstyledButton>
  ) : (
    <ActionIcon
      size={btn}
      variant="subtle"
      color="gray"
      onClick={toggleSettings}
      aria-label={settingsLabel}
      aria-haspopup="dialog"
      aria-expanded={settingsOpen}
      data-testid="click-strip-settings"
    >
      <IconAdjustmentsHorizontal size={Math.min(18, btn - 8)} />
    </ActionIcon>
  );

  const panel = (
    <Stack gap="sm">
      {!inlineFader && (
        <div>
          <Text size="xs" fw={600} mb={4}>
            {t("click.volume")}
          </Text>
          {fader}
        </div>
      )}
      <ClickSettingsForm />
    </Stack>
  );

  // Phones and short screens: a full-screen panel; wider headers: a popover beside the header
  // (like a track's ⚙).
  const settings = (
    <PanelPopover
      opened={settingsOpen}
      onChange={setSettingsOpen}
      position="right"
      withArrow
      width={320}
      title={settingsLabel}
      target={target}
    >
      {panel}
    </PanelPopover>
  );

  let content;
  if (compact) {
    content = (
      <Box pos="relative" style={{ flex: 1, minWidth: 0 }}>
        {settings}
        <Group
          gap={2}
          wrap="nowrap"
          pos="absolute"
          style={
            tier === "one"
              ? { right: 2, top: "50%", transform: "translateY(-50%)" }
              : { left: 2, bottom: 2 }
          }
        >
          {buttons}
        </Group>
      </Box>
    );
  } else if (tier === "one") {
    content = (
      <Group gap={4} px={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
        <Box style={{ flex: 1, minWidth: 0 }}>{nameText}</Box>
        {buttons}
        {settings}
      </Group>
    );
  } else {
    content = (
      <Stack gap={2} px={6} py={2} justify="center" style={{ flex: 1, minWidth: 0 }}>
        {nameText}
        <Group gap={4} wrap="nowrap">
          {buttons}
          {fader}
          {settings}
        </Group>
      </Stack>
    );
  }

  return (
    <Group
      gap={0}
      h="100%"
      wrap="nowrap"
      align="stretch"
      data-testid="click-strip"
      data-tier={tier}
      style={{
        borderBottom: "1px solid var(--mantine-color-default-border)",
        background: trackTint(CLICK_LANE_COLOR),
      }}
    >
      <Box
        w={4}
        aria-hidden
        style={{ flex: "none", background: `var(--mantine-color-${CLICK_LANE_COLOR}-6)` }}
      />
      {content}
    </Group>
  );
}
