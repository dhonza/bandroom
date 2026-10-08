import { FORMANT_MODES, FORMANT_SHIFT, type FormantMode } from "@bandroom/shared";
import { Box, Group, SegmentedControl, Slider, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { signed } from "./practiceLabel";

/** "band" = no personal override (the band default applies). */
export type FormantModeChoice = FormantMode | "band";

/**
 * Formant mode and shift (SPEC §30.3): the band default in the track dialog and the lane
 * settings, or a personal override ("For me", with a "Band" choice for each).
 */
export function FormantFields({
  mode,
  shift,
  onMode,
  onShift,
  onShiftEnd,
  personal = false,
  disabled = false,
  note,
  testId,
}: {
  mode: FormantModeChoice;
  /** null = the band default (personal only). */
  shift: number | null;
  onMode: (mode: FormantModeChoice) => void;
  /** While dragging; `onShiftEnd` when released (saves). null = back to the band default. */
  onShift?: (shift: number | null) => void;
  onShiftEnd?: (shift: number | null) => void;
  personal?: boolean;
  disabled?: boolean;
  note?: string | undefined;
  testId: string;
}) {
  const { t } = useTranslation();
  const modes: FormantModeChoice[] = personal ? ["band", ...FORMANT_MODES] : [...FORMANT_MODES];
  const own = shift !== null;
  return (
    <Stack gap={6}>
      <Box>
        <Text size="sm" fw={500} mb={4}>
          {t("practice.formants")}
        </Text>
        <SegmentedControl
          fullWidth
          size="xs"
          disabled={disabled}
          value={mode}
          onChange={(v) => {
            const m = modes.find((x) => x === v);
            if (m) onMode(m);
          }}
          data={modes.map((m) => ({ value: m, label: t(`practice.formantModes.${m}`) }))}
          data-testid={`${testId}-formants`}
        />
      </Box>
      <Box>
        <Group justify="space-between" mb={4} wrap="nowrap">
          <Text size="sm" fw={500}>
            {t("practice.formantShift")}
          </Text>
          <Text size="sm" className="tabular-nums" data-testid={`${testId}-shift-value`}>
            {own ? t("practice.semitonesShort", { value: signed(shift) }) : t("practice.band")}
          </Text>
        </Group>
        {personal && (
          <SegmentedControl
            fullWidth
            size="xs"
            mb={6}
            disabled={disabled}
            value={own ? "own" : "band"}
            onChange={(v) => {
              const next = v === "own" ? 0 : null;
              onShift?.(next);
              onShiftEnd?.(next);
            }}
            data={[
              { value: "band", label: t("practice.formantModes.band") },
              { value: "own", label: t("practice.ownShift") },
            ]}
            data-testid={`${testId}-shift-own`}
          />
        )}
        {(own || !personal) && (
          <Slider
            min={-FORMANT_SHIFT}
            max={FORMANT_SHIFT}
            step={1}
            disabled={disabled}
            value={shift ?? 0}
            label={(v) => t("practice.semitonesShort", { value: signed(v) })}
            marks={[{ value: 0 }]}
            onChange={(v) => onShift?.(v)}
            onChangeEnd={(v) => onShiftEnd?.(v)}
            aria-label={t("practice.formantShift")}
            thumbSize={22}
            data-testid={`${testId}-shift`}
          />
        )}
      </Box>
      {note && (
        <Text size="xs" c="dimmed">
          {note}
        </Text>
      )}
    </Stack>
  );
}
