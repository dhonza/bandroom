import { MANUAL_MAX_BPM, MANUAL_MIN_BPM } from "@bandroom/shared";
import { ActionIcon, Autocomplete, Box, NumberInput, Text, Tooltip } from "@mantine/core";
import { IconTrash, IconTrendingDown, IconTrendingUp } from "@tabler/icons-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { MAX_EDIT_BAR, METER_PRESETS, parseMeter, type ChangeRow } from "./model";

/** Columns of the change table: bar, beat, BPM, time signature, delete (fits 360 px). */
const GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "56px 48px 72px 72px auto",
  columnGap: 6,
  alignItems: "start",
};

/** Placeholder of an empty value: this row does not change it. */
const NO_CHANGE = "—";

/** Touch-target height on coarse pointers (SPEC §11.1), compact `sm` inputs otherwise. */
const inputStyles = (coarse: boolean) =>
  coarse ? { input: { height: 44, minHeight: 44 } } : undefined;

/** The column labels above the change rows. */
export function ChangeTableHeader() {
  const { t } = useTranslation();
  const label = (text: string) => (
    <Text size="xs" c="dimmed" fw={500} truncate>
      {text}
    </Text>
  );
  return (
    <Box style={GRID} aria-hidden data-testid="tempo-changes-header">
      {label(t("tempo.position"))}
      {label(t("tempo.beat"))}
      {label(t("tempo.bpm"))}
      {label(t("tempo.sigShort"))}
    </Box>
  );
}

/**
 * One tempo and/or time signature change as a compact table row: bar, beat (tempo changes only),
 * BPM and time signature. An empty BPM or time signature keeps what is in effect there.
 */
export function ChangeRowEditor({
  row,
  coarse,
  invalid,
  onChange,
  onRemove,
}: {
  row: ChangeRow;
  coarse: boolean;
  invalid: boolean;
  onChange: (patch: Partial<ChangeRow>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const tempoOn = row.bpm !== null;
  const meterOn = row.meter !== null;
  const bpmInvalid =
    typeof row.bpm !== "number" || row.bpm < MANUAL_MIN_BPM || row.bpm > MANUAL_MAX_BPM;
  const styles = inputStyles(coarse);
  const ramp =
    row.bpmEnd !== undefined && typeof row.bpm === "number" ? (
      <Tooltip
        label={t("tempo.rampTo", { bpm: row.bpmEnd })}
        events={{ hover: true, focus: true, touch: true }}
      >
        <Box
          component="span"
          tabIndex={0}
          aria-label={t("tempo.rampTo", { bpm: row.bpmEnd })}
          style={{ display: "inline-flex" }}
          data-testid="tempo-change-ramp"
        >
          {row.bpmEnd >= row.bpm ? <IconTrendingUp size={14} /> : <IconTrendingDown size={14} />}
        </Box>
      </Tooltip>
    ) : undefined;
  return (
    <Box style={GRID} data-testid="tempo-change">
      <NumberInput
        aria-label={t("tempo.position")}
        size="sm"
        styles={styles}
        hideControls
        value={row.bar}
        min={2}
        max={MAX_EDIT_BAR}
        step={1}
        allowDecimal={false}
        onChange={(v) => {
          onChange({ bar: v });
        }}
        error={invalid}
        data-testid="tempo-change-bar"
      />
      <NumberInput
        aria-label={t("tempo.beat")}
        size="sm"
        styles={styles}
        hideControls
        value={tempoOn ? row.beat : ""}
        placeholder={tempoOn ? undefined : NO_CHANGE}
        disabled={!tempoOn}
        min={1}
        step={1}
        decimalScale={3}
        onChange={(v) => {
          onChange({ beat: v });
        }}
        data-testid="tempo-change-beat"
      />
      <NumberInput
        aria-label={t("tempo.bpm")}
        size="sm"
        styles={styles}
        hideControls
        value={row.bpm ?? ""}
        placeholder={NO_CHANGE}
        min={MANUAL_MIN_BPM}
        max={MANUAL_MAX_BPM}
        decimalScale={3}
        rightSection={ramp}
        rightSectionWidth={ramp ? 20 : undefined}
        rightSectionPointerEvents={ramp ? "all" : undefined}
        onChange={(v) => {
          // Empty: no tempo change here; only tempo changes may sit off the downbeat.
          onChange(v === "" ? { bpm: null, beat: 1, bpmEnd: undefined } : { bpm: v });
        }}
        error={tempoOn && bpmInvalid}
        data-testid="tempo-change-bpm"
      />
      <Autocomplete
        aria-label={t("tempo.timeSignature")}
        size="sm"
        styles={styles}
        data={METER_PRESETS}
        value={row.meter ?? ""}
        placeholder={NO_CHANGE}
        onChange={(v) => {
          onChange({ meter: v.trim() === "" ? null : v });
        }}
        error={meterOn && !parseMeter(row.meter ?? "")}
        data-testid="tempo-change-meter"
      />
      <ActionIcon
        size={coarse ? 44 : "input-sm"}
        variant="subtle"
        color="red"
        aria-label={t("tempo.removeChange")}
        onClick={onRemove}
      >
        <IconTrash size={16} />
      </ActionIcon>
    </Box>
  );
}
