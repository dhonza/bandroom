import { CLICK_SOUNDS } from "@bandroom/audio-engine";
import type { ClickSettings } from "@bandroom/shared";
import {
  ActionIcon,
  Box,
  Menu,
  SegmentedControl,
  Slider,
  Stack,
  Switch,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconMetronome } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AppModal } from "../components/ResponsivePanel";
import { CountInIcon } from "./CountInIcon";
import { useTempoUi } from "../tempo/store";
import { countInNow, setClickSettings, usePlayerView } from "./controller";
import { clickSettingsOf } from "./model";

/** Click and count-in settings of the open song (personal, saved with the mixer state). */
export function useClickSettings(): ClickSettings {
  // Select the stored object (stable reference) and merge the defaults outside the selector.
  const click = usePlayerView((s) => s.mix.click);
  return useMemo(() => clickSettingsOf({ click }), [click]);
}

function useHasTempo(): boolean {
  const songId = usePlayerView((s) => s.songId);
  return useTempoUi((s) => s.grid !== null && s.songId === songId);
}

/** The click volume's range, as in the click settings (SPEC §6.7). */
export const CLICK_FADER_MIN = -40;
export const CLICK_FADER_MAX = 6;

/** The click fader's value label: "-6 dB", "0 dB", "+6 dB". */
export function clickDbLabel(t: TFunction, v: number): string {
  return t("rehearse.db", { value: v > 0 ? `+${v}` : String(v) });
}

/**
 * The full settings form (SPEC §6.7): volume, sound, subdivision, accent, compound, solo.
 * `hideVolume` leaves out the volume fader where the host shows its own (the Mixer's click lane).
 */
export function ClickSettingsForm({ hideVolume = false }: { hideVolume?: boolean }) {
  const { t } = useTranslation();
  const c = useClickSettings();
  return (
    <Stack gap="sm" data-testid="click-settings">
      <Switch
        label={t("click.click")}
        checked={c.enabled}
        onChange={(e) => {
          setClickSettings({ enabled: e.currentTarget.checked });
        }}
        data-testid="click-enabled"
      />
      {!hideVolume && (
        <Box>
          <Text size="sm" mb={4}>
            {t("click.volume")}
          </Text>
          <Slider
            min={CLICK_FADER_MIN}
            max={CLICK_FADER_MAX}
            step={1}
            value={Math.max(CLICK_FADER_MIN, c.gainDb)}
            label={(v) => clickDbLabel(t, v)}
            onChange={(v) => {
              setClickSettings({ gainDb: v });
            }}
            aria-label={t("click.volume")}
            thumbLabel={t("click.volume")}
            thumbSize={22}
          />
        </Box>
      )}
      <Stack gap={4}>
        <Text size="sm">{t("click.sound")}</Text>
        <SegmentedControl
          value={c.sound}
          onChange={(v) => {
            const sound = CLICK_SOUNDS.find((x) => x === v);
            if (sound) setClickSettings({ sound });
          }}
          data={CLICK_SOUNDS.map((s) => ({ value: s, label: t(`click.sounds.${s}`) }))}
        />
      </Stack>
      <Stack gap={4}>
        <Text size="sm">{t("click.subdivision")}</Text>
        <SegmentedControl
          value={String(c.subdivision)}
          onChange={(v) => {
            setClickSettings({ subdivision: v === "4" ? 4 : v === "2" ? 2 : 1 });
          }}
          data={(["1", "2", "4"] as const).map((v) => ({
            value: v,
            label: t(`click.subdivisions.${v}`),
          }))}
          data-testid="click-subdivision"
        />
      </Stack>
      <Switch
        label={t("click.accent")}
        checked={c.accent}
        onChange={(e) => {
          setClickSettings({ accent: e.currentTarget.checked });
        }}
      />
      <Switch
        label={t("click.compoundEighths")}
        checked={c.compoundEighths}
        onChange={(e) => {
          setClickSettings({ compoundEighths: e.currentTarget.checked });
        }}
      />
      <Switch
        label={t("click.solo")}
        checked={c.solo}
        onChange={(e) => {
          setClickSettings({ solo: e.currentTarget.checked });
        }}
      />
      <Switch
        label={t("click.soloExcludes")}
        checked={c.soloExcludes}
        onChange={(e) => {
          setClickSettings({ soloExcludes: e.currentTarget.checked });
        }}
      />
      <Switch
        label={t("click.countIn")}
        checked={c.countIn}
        onChange={(e) => {
          setClickSettings({ countIn: e.currentTarget.checked });
        }}
        data-testid="count-in-enabled"
      />
      <Stack gap={4}>
        <Text size="sm">{t("click.countInBars")}</Text>
        <SegmentedControl
          value={String(c.countInBars)}
          onChange={(v) => {
            setClickSettings({ countInBars: v === "2" ? 2 : 1 });
          }}
          data={[1, 2].map((n) => ({ value: String(n), label: t("click.bars", { count: n }) }))}
          data-testid="count-in-bars"
        />
      </Stack>
      <Switch
        label={t("click.everyRepeat")}
        checked={c.countInEveryRepeat}
        onChange={(e) => {
          setClickSettings({ countInEveryRepeat: e.currentTarget.checked });
        }}
      />
    </Stack>
  );
}

/**
 * Count-in and click as icon toggles (SPEC §31.5): on = filled grape, off = subtle grey; greyed
 * out with "Set tempo to enable" without a tempo map (SPEC §6.7). The settings are in "⋯".
 */
export function ClickToggles({ size = 44 }: { size?: number }) {
  const { t } = useTranslation();
  const c = useClickSettings();
  const tempo = useHasTempo();
  const icon = Math.round(size * 0.45);
  return (
    <>
      <ClickToggle
        label={t("click.countIn")}
        tip={c.countIn ? t("click.countInOn") : t("click.countInOff")}
        on={c.countIn}
        tempo={tempo}
        size={size}
        patch={{ countIn: !c.countIn }}
        testId="count-in-toggle"
      >
        <CountInIcon size={icon} />
      </ClickToggle>
      <ClickToggle
        label={t("click.click")}
        tip={c.enabled ? t("click.clickOn") : t("click.clickOff")}
        on={c.enabled}
        tempo={tempo}
        size={size}
        patch={{ enabled: !c.enabled }}
        testId="click-toggle"
      >
        <IconMetronome size={icon} />
      </ClickToggle>
    </>
  );
}

function ClickToggle({
  label,
  tip,
  on,
  tempo,
  size,
  patch,
  testId,
  children,
}: {
  label: string;
  tip: string;
  on: boolean;
  tempo: boolean;
  size: number;
  patch: Partial<ClickSettings>;
  testId: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip label={tempo ? tip : t("click.noTempo")}>
      <ActionIcon
        size={size}
        variant={on && tempo ? "filled" : "subtle"}
        color={on && tempo ? "grape" : "gray"}
        disabled={!tempo}
        aria-label={label}
        aria-pressed={on}
        onClick={() => {
          setClickSettings(patch);
        }}
        data-testid={testId}
      >
        {children}
      </ActionIcon>
    </Tooltip>
  );
}

/** Phone "⋯" menu items (SPEC §11.3): click, count-in, every repeat, settings. */
export function ClickMenuItems({ onSettings }: { onSettings: () => void }) {
  const { t } = useTranslation();
  const c = useClickSettings();
  const tempo = useHasTempo();
  const check = (on: boolean) => (on ? <IconCheck size={14} /> : <Box w={14} />);
  return (
    <>
      <Menu.Label>{tempo ? t("click.click") : t("click.noTempo")}</Menu.Label>
      <Menu.Item
        leftSection={check(c.enabled)}
        disabled={!tempo}
        onClick={() => {
          setClickSettings({ enabled: !c.enabled });
        }}
        data-testid="menu-click"
      >
        {t("click.click")}
      </Menu.Item>
      <Menu.Item
        leftSection={check(c.countIn)}
        disabled={!tempo}
        onClick={() => {
          setClickSettings({ countIn: !c.countIn });
        }}
        data-testid="menu-count-in"
      >
        {t("click.countIn")}
      </Menu.Item>
      <Menu.Item
        leftSection={check(c.countInEveryRepeat)}
        disabled={!tempo}
        onClick={() => {
          setClickSettings({ countInEveryRepeat: !c.countInEveryRepeat });
        }}
      >
        {t("click.everyRepeat")}
      </Menu.Item>
      <Menu.Item
        leftSection={<IconMetronome size={14} />}
        disabled={!tempo}
        onClick={onSettings}
        data-testid="menu-click-settings"
      >
        {t("click.settings")}
      </Menu.Item>
    </>
  );
}

/** Loop options on long-press (SPEC §11.3): count-in on the first pass and every repeat. */
export function LoopCountInOptions() {
  const { t } = useTranslation();
  const c = useClickSettings();
  const tempo = useHasTempo();
  const check = (on: boolean) => (on ? <IconCheck size={14} /> : <Box w={14} />);
  if (!tempo) return <Menu.Item disabled>{t("click.noTempo")}</Menu.Item>;
  return (
    <>
      <Menu.Item
        leftSection={check(c.countIn)}
        onClick={() => {
          setClickSettings({ countIn: !c.countIn });
        }}
        data-testid="loop-option-count-in"
      >
        {t("click.countIn")}
      </Menu.Item>
      <Menu.Item
        leftSection={check(c.countIn && c.countInEveryRepeat)}
        onClick={() => {
          const on = !(c.countIn && c.countInEveryRepeat);
          setClickSettings(
            on ? { countIn: true, countInEveryRepeat: true } : { countInEveryRepeat: false },
          );
        }}
        data-testid="loop-option-every-repeat"
      >
        {t("click.everyRepeat")}
      </Menu.Item>
    </>
  );
}

/** Settings as a modal (phones: full screen). */
export function ClickSettingsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <AppModal opened={opened} onClose={onClose} title={t("click.settings")} centered>
      <ClickSettingsForm />
    </AppModal>
  );
}

/**
 * Count-in countdown over the readout ("2… 3… 4…", SPEC §6.7), polled every animation frame
 * from the engine; renders nothing outside a count-in.
 */
export function CountInCountdown() {
  const { t } = useTranslation();
  const [state, setState] = useState<{ beat: number; clicks: number } | null>(null);
  const last = useRef("");
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const c = countInNow();
      const key = c ? `${c.beat}/${c.clicks}` : "";
      if (key !== last.current) {
        last.current = key;
        setState(c);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, []);
  if (!state) return null;
  return (
    <Text
      size="32px"
      fw={900}
      c="grape"
      className="tabular-nums"
      aria-live="assertive"
      aria-label={t("click.countingIn", { beat: state.beat, clicks: state.clicks })}
      data-testid="count-in-countdown"
    >
      {state.beat}…
    </Text>
  );
}
