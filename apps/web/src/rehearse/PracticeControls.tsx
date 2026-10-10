import {
  DEFAULT_PRACTICE,
  effectiveInstrument,
  effectiveTranspose,
  isNeutralPractice,
  practiceOf,
  type Practice,
} from "@bandroom/shared";
import { ActionIcon, Box, Button, Group, Menu, Slider, Stack, Text, Tooltip } from "@mantine/core";
import { IconGauge, IconMinus, IconPlus, IconPlayerTrackNext } from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useMemo } from "react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import type { PracticeAction } from "../markers/shortcuts";
import { pageState, setPractice, usePlayerView } from "./controller";
import { AppModal, PanelPopover } from "../components/ResponsivePanel";
import { practiceLabel as label, practiceShortLabel, signed } from "./practiceLabel";

/** Speed limits (SPEC §30.2) and the range where quality holds up. */
export const PRACTICE_RATE = { min: 0.25, max: 2, goodMin: 0.5, goodMax: 1.5 } as const;
export const PRACTICE_SEMITONES = 24;
export const PRACTICE_CENTS = 100;
const SPEED_PRESETS = [50, 75, 85, 100] as const;
/** A = 432 Hz / 442 Hz relative to 440 Hz, in cents (rounded). */
const TUNINGS = [
  { hz: 432, cents: -32 },
  { hz: 442, cents: 8 },
] as const;

/** The open song's practice setting (personal, saved with the mixer state). */
export function usePractice(): Practice {
  const practice = usePlayerView((s) => s.mix.practice);
  return useMemo(() => practiceOf({ practice }), [practice]);
}

/** Speed in whole percent. */
export function ratePercent(rate: number): number {
  return Math.round(rate * 100);
}

/** "85 % · −2 st · +8 ct" (only what differs from the original). */
export function practiceLabel(t: TFunction, p: Practice): string {
  return label(p, t, " · ");
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

const currentPractice = (): Practice => practiceOf(pageState().mix);

/** Speed changed by `deltaPercent` (keyboard, pedal), within the limits. */
export function nudgeSpeed(deltaPercent: number): void {
  const p = currentPractice();
  const next = clamp(ratePercent(p.rate) + deltaPercent, 25, 200) / 100;
  setPractice({ rate: next });
}

/** Pitch changed by whole semitones (keyboard, pedal). */
export function nudgePitch(delta: number): void {
  const p = currentPractice();
  setPractice({ semitones: clamp(p.semitones + delta, -PRACTICE_SEMITONES, PRACTICE_SEMITONES) });
}

export function resetPractice(): void {
  setPractice(DEFAULT_PRACTICE);
}

/** Keyboard and pedal actions (SPEC §30.6). */
export function practiceShortcut(action: PracticeAction): void {
  if (action === "practiceSlower") nudgeSpeed(-5);
  else if (action === "practiceFaster") nudgeSpeed(5);
  else if (action === "practicePitchDown") nudgePitch(-1);
  else if (action === "practicePitchUp") nudgePitch(1);
  else resetPractice();
}

/** One-line quality hints (SPEC §30.6). */
function usePracticeHints(p: Practice): string[] {
  const { t } = useTranslation();
  const tracks = usePlayerView((s) => s.tracks);
  return useMemo(() => {
    const single = tracks.length === 1;
    const instruments = tracks.map((x) => ({
      instrument: effectiveInstrument(x.track, { singleTrack: single }),
      transpose: effectiveTranspose(x.track, { singleTrack: single }),
    }));
    const hints: string[] = [];
    if (p.rate < PRACTICE_RATE.goodMin || p.rate > PRACTICE_RATE.goodMax) {
      hints.push(t("practice.hintExtreme"));
    } else if (
      p.rate < 0.7 &&
      instruments.some((i) => i.instrument === "drums" || i.instrument === "percussion")
    ) {
      hints.push(t("practice.hintDrums"));
    }
    if (
      Math.abs(p.semitones) > 5 &&
      instruments.some((i) => i.instrument === "vocals" && i.transpose)
    ) {
      hints.push(t("practice.hintVoice"));
    }
    return hints;
  }, [tracks, p.rate, p.semitones, t]);
}

/** The Practice form (SPEC §30.6): speed, pitch, fine tune, reset. */
export function PracticeForm() {
  const { t } = useTranslation();
  const p = usePractice();
  const hints = usePracticeHints(p);
  const percent = ratePercent(p.rate);
  return (
    <Stack gap="sm" data-testid="practice-form">
      <Box>
        <Group justify="space-between" mb={4}>
          <Text size="sm">{t("practice.speed")}</Text>
          <Text size="sm" fw={600} className="tabular-nums" data-testid="practice-speed-value">
            {t("practice.percent", { value: percent })}
          </Text>
        </Group>
        <Group gap={4} wrap="nowrap">
          <Stepper
            label={t("practice.slower")}
            icon="minus"
            disabled={percent <= 25}
            onClick={() => {
              nudgeSpeed(-1);
            }}
            testId="practice-speed-down"
          />
          <Slider
            style={{ flex: 1 }}
            min={25}
            max={200}
            step={5}
            value={percent}
            label={(v) => t("practice.percent", { value: v })}
            onChange={(v) => {
              setPractice({ rate: v / 100 });
            }}
            aria-label={t("practice.speed")}
            thumbSize={22}
            data-testid="practice-speed"
          />
          <Stepper
            label={t("practice.faster")}
            icon="plus"
            disabled={percent >= 200}
            onClick={() => {
              nudgeSpeed(1);
            }}
            testId="practice-speed-up"
          />
        </Group>
        <Group gap={4} mt={6}>
          {SPEED_PRESETS.map((v) => (
            <Button
              key={v}
              h={44}
              size="xs"
              variant={percent === v ? "filled" : "default"}
              onClick={() => {
                setPractice({ rate: v / 100 });
              }}
              data-testid={`practice-preset-${v}`}
            >
              {t("practice.percent", { value: v })}
            </Button>
          ))}
        </Group>
      </Box>
      <Box>
        <Text size="sm" mb={4}>
          {t("practice.pitch")}
        </Text>
        <Group gap={4} wrap="nowrap">
          <Stepper
            label={t("practice.pitchDown")}
            icon="minus"
            disabled={p.semitones <= -PRACTICE_SEMITONES}
            onClick={() => {
              nudgePitch(-1);
            }}
            testId="practice-pitch-down"
          />
          <Text
            fw={600}
            ta="center"
            miw={96}
            className="tabular-nums"
            aria-live="polite"
            data-testid="practice-pitch-value"
          >
            {t("practice.semitones", { count: p.semitones, value: signed(p.semitones) })}
          </Text>
          <Stepper
            label={t("practice.pitchUp")}
            icon="plus"
            disabled={p.semitones >= PRACTICE_SEMITONES}
            onClick={() => {
              nudgePitch(1);
            }}
            testId="practice-pitch-up"
          />
        </Group>
      </Box>
      <Box>
        <Group justify="space-between" mb={4}>
          <Text size="sm">{t("practice.fineTune")}</Text>
          <Text size="sm" fw={600} className="tabular-nums" data-testid="practice-cents-value">
            {t("practice.centsShort", { value: signed(p.cents) })}
          </Text>
        </Group>
        <Slider
          min={-PRACTICE_CENTS}
          max={PRACTICE_CENTS}
          step={1}
          value={p.cents}
          label={(v) => t("practice.centsShort", { value: signed(v) })}
          onChange={(v) => {
            setPractice({ cents: v });
          }}
          aria-label={t("practice.fineTune")}
          thumbSize={22}
        />
        <Group gap={4} mt={6}>
          {TUNINGS.map((x) => (
            <Button
              key={x.hz}
              h={44}
              size="xs"
              variant={p.cents === x.cents ? "filled" : "default"}
              onClick={() => {
                setPractice({ cents: x.cents });
              }}
              data-testid={`practice-tune-${x.hz}`}
            >
              {t("practice.tuneTo", { hz: x.hz })}
            </Button>
          ))}
        </Group>
      </Box>
      {hints.map((h) => (
        <Text key={h} size="xs" c="yellow" data-testid="practice-hint">
          {h}
        </Text>
      ))}
      <Button
        h={44}
        variant="default"
        disabled={isNeutralPractice(p)}
        onClick={resetPractice}
        data-testid="practice-reset"
      >
        {t("practice.reset")}
      </Button>
    </Stack>
  );
}

function Stepper({
  label,
  icon,
  disabled,
  onClick,
  testId,
}: {
  label: string;
  icon: "minus" | "plus";
  disabled: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <ActionIcon
      size={44}
      variant="default"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      {icon === "minus" ? <IconMinus size={16} /> : <IconPlus size={16} />}
    </ActionIcon>
  );
}

/**
 * The Practice target (SPEC §30.6, §31.1): an icon while neutral, the setting in a few
 * characters while not; `label` gives the longer desktop form.
 */
function PracticeTarget({
  size,
  long,
  testId,
  onClick,
}: {
  size: number;
  long: boolean;
  testId: string;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const p = usePractice();
  const active = !isNeutralPractice(p);
  if (!active) {
    return (
      <ActionIcon
        size={size}
        variant="subtle"
        color="gray"
        aria-label={t("practice.title")}
        onClick={onClick}
        data-testid={testId}
      >
        <IconGauge size={Math.round(size * 0.5)} />
      </ActionIcon>
    );
  }
  return (
    <Button
      h={size}
      px={8}
      size="compact-sm"
      variant="filled"
      color="teal"
      leftSection={<IconGauge size={16} />}
      aria-label={t("practice.active", { label: practiceLabel(t, p) })}
      onClick={onClick}
      data-testid={testId}
    >
      {long ? practiceLabel(t, p) : practiceShortLabel(p, t)}
    </Button>
  );
}

/** Desktop transport: the Practice target opens the form in a popover. */
export function PracticeButton({ size = 44 }: { size?: number }) {
  const { t } = useTranslation();
  return (
    <PanelPopover
      position="top-end"
      width={340}
      title={t("practice.title")}
      target={
        <span style={{ display: "inline-flex" }}>
          <Tooltip label={t("practice.title")}>
            <PracticeTarget size={size} long testId="practice-button" />
          </Tooltip>
        </span>
      }
    >
      <PracticeForm />
    </PanelPopover>
  );
}

/** Phone "⋯" menu item. */
export function PracticeMenuItem({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  const p = usePractice();
  return (
    <Menu.Item
      leftSection={<IconPlayerTrackNext size={14} />}
      // The "⋯" menu stays open on item clicks; the sheet must not open under it.
      closeMenuOnClick
      onClick={onOpen}
      data-testid="menu-practice"
    >
      {isNeutralPractice(p)
        ? t("practice.title")
        : t("practice.active", { label: practiceLabel(t, p) })}
    </Menu.Item>
  );
}

/** Phones and landscape (SPEC §31.1): the Practice target opens the full-screen panel. */
export function PracticePhoneButton({ onOpen, size = 44 }: { onOpen: () => void; size?: number }) {
  return (
    <PracticeTarget size={size} long={false} testId="practice-phone-button" onClick={onOpen} />
  );
}

/** The phone panel's open state (opened from the "⋯" menu or the readout button). */
export const usePracticeSheet = create<{ open: boolean }>(() => ({ open: false }));

export function openPracticeSheet(): void {
  usePracticeSheet.setState({ open: true });
}

/** The form as a full-screen panel (phones). */
export function PracticeSheet() {
  const { t } = useTranslation();
  const opened = usePracticeSheet((s) => s.open);
  return (
    <AppModal
      opened={opened}
      onClose={() => {
        usePracticeSheet.setState({ open: false });
      }}
      title={t("practice.title")}
      centered
      data-testid="practice-sheet"
    >
      <PracticeForm />
    </AppModal>
  );
}
