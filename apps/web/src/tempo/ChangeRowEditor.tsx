import { MANUAL_MAX_BPM, MANUAL_MIN_BPM } from "@bandroom/shared";
import {
  ActionIcon,
  Autocomplete,
  Box,
  Group,
  NumberInput,
  Paper,
  Stack,
  Switch,
} from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { MAX_EDIT_BAR, METER_PRESETS, parseMeter, type ChangeRow } from "./model";

/** Switch areas as tall as a touch target (SPEC §11.1). */
const SWITCH_STYLES = { body: { minHeight: 44, alignItems: "center" } } as const;

/**
 * One tempo and/or time signature change: bar (and beat for tempo changes), each aspect with an
 * on/off switch. Phones get a two-line card (position and delete, then the values).
 */
export function ChangeRowEditor({
  row,
  phone,
  invalid,
  inEffect,
  onChange,
  onRemove,
}: {
  row: ChangeRow;
  phone: boolean;
  invalid: boolean;
  /** Tempo and time signature in effect at the row's bar (for switching an aspect on). */
  inEffect: () => { bpm: number; meter: string };
  onChange: (patch: Partial<ChangeRow>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const tempoOn = row.bpm !== null;
  const meterOn = row.meter !== null;
  const bpmInvalid =
    typeof row.bpm !== "number" || row.bpm < MANUAL_MIN_BPM || row.bpm > MANUAL_MAX_BPM;
  const position = (
    <Group gap="xs" wrap="nowrap" align="flex-end">
      <NumberInput
        label={t("tempo.position")}
        value={row.bar}
        min={2}
        max={MAX_EDIT_BAR}
        step={1}
        allowDecimal={false}
        w={76}
        onChange={(v) => {
          onChange({ bar: v });
        }}
        error={invalid}
        data-testid="tempo-change-bar"
      />
      {tempoOn && (
        <NumberInput
          label={t("tempo.beat")}
          value={row.beat}
          min={1}
          step={1}
          decimalScale={3}
          w={70}
          onChange={(v) => {
            onChange({ beat: v });
          }}
          data-testid="tempo-change-beat"
        />
      )}
    </Group>
  );
  const remove = (
    <ActionIcon
      size={44}
      variant="subtle"
      color="red"
      aria-label={t("tempo.removeChange")}
      onClick={onRemove}
      ml={phone ? "auto" : undefined}
    >
      <IconTrash size={16} />
    </ActionIcon>
  );
  const values = (
    <Group gap="xs" wrap="wrap" align="flex-end">
      <Stack gap={0}>
        <Switch
          label={t("tempo.bpm")}
          aria-label={t("tempo.tempoOn")}
          checked={tempoOn}
          styles={SWITCH_STYLES}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            if (!on && !meterOn) onRemove();
            else onChange(on ? { bpm: inEffect().bpm } : { bpm: null, beat: 1, bpmEnd: undefined });
          }}
          data-testid="tempo-change-tempo-on"
        />
        <NumberInput
          aria-label={t("tempo.bpm")}
          value={row.bpm ?? ""}
          disabled={!tempoOn}
          min={MANUAL_MIN_BPM}
          max={MANUAL_MAX_BPM}
          decimalScale={3}
          w={100}
          onChange={(v) => {
            onChange({ bpm: v });
          }}
          error={tempoOn && bpmInvalid}
          data-testid="tempo-change-bpm"
        />
      </Stack>
      <Stack gap={0}>
        <Switch
          label={t("tempo.timeSignature")}
          aria-label={t("tempo.meterOn")}
          checked={meterOn}
          styles={SWITCH_STYLES}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            if (!on && !tempoOn) onRemove();
            else onChange({ meter: on ? inEffect().meter : null });
          }}
          data-testid="tempo-change-meter-on"
        />
        <Autocomplete
          aria-label={t("tempo.timeSignature")}
          data={METER_PRESETS}
          value={row.meter ?? ""}
          disabled={!meterOn}
          w={120}
          onChange={(v) => {
            onChange({ meter: v });
          }}
          error={meterOn && !parseMeter(row.meter ?? "")}
          data-testid="tempo-change-meter"
        />
      </Stack>
    </Group>
  );
  return (
    <Paper withBorder p="xs" data-testid="tempo-change">
      {phone ? (
        <Stack gap={6}>
          <Group gap="xs" wrap="nowrap" align="flex-end">
            {position}
            {remove}
          </Group>
          {values}
        </Stack>
      ) : (
        <Group gap="sm" wrap="nowrap" align="flex-end">
          {position}
          {values}
          <Box ml="auto">{remove}</Box>
        </Group>
      )}
    </Paper>
  );
}
