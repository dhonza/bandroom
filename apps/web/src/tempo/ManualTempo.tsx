import { MANUAL_MAX_BPM, MANUAL_MIN_BPM, type Song, type SongTempo } from "@bandroom/shared";
import { Alert, Autocomplete, Button, Group, NumberInput, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApiError } from "../api/useApiError";
import { positionNow } from "../markers/store";
import { PHONE_QUERY } from "../shell/mediaQueries";
import { ChangeRowEditor } from "./ChangeRowEditor";
import { clampManualBpm, offsetFromInput, roundMs } from "./midi";
import {
  addChangeAtBar,
  addTap,
  inEffectAtBar,
  mapFromRows,
  MAX_EDIT_BAR,
  METER_PRESETS,
  parseMeter,
  rowsFromMap,
  tapBpm,
  type ChangeKind,
  type ChangeRow,
  type HeadRow,
} from "./model";
import { useTempoActions } from "./queries";
import { previewTempo } from "./store";
import { BTN } from "./styles";

/** Manual tempo editing (SPEC §7.3): head tempo and meter, tap tempo, bar 1 offset, changes. */
export function ManualTempo({
  song,
  tempo,
  onDone,
}: {
  song: Song;
  tempo: SongTempo | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const actions = useTempoActions(song.id);
  const [initial] = useState(() =>
    tempo ? rowsFromMap(tempo.map) : { head: { bpm: 120, meter: "4/4" }, rows: [] },
  );
  const [head, setHead] = useState<HeadRow>(initial.head);
  const [rows, setRows] = useState<ChangeRow[]>(initial.rows);
  const phone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const [offset, setOffset] = useState<number>(tempo?.bar1OffsetSec ?? 0);
  const [taps, setTaps] = useState<number[]>([]);
  const [addBar, setAddBar] = useState<number | string>(5);
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => mapFromRows(head, rows), [head, rows]);

  // Live preview of the grid while editing (SPEC §7.3 "drag the grid").
  useEffect(() => {
    if (!parsed.ok) return;
    previewTempo(song.id, {
      map: { segments: parsed.segments },
      bar1OffsetSec: offset,
      source: "manual",
      midiFileName: null,
      revisionId: "draft",
      updatedByName: null,
      updatedAt: 0,
    });
  }, [parsed, offset, song.id]);

  const setRow = (id: string, patch: Partial<ChangeRow>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const setHeadField = (patch: Partial<HeadRow>) => {
    setHead((h) => ({ ...h, ...patch }));
  };
  const add = (kind: ChangeKind) => {
    const next = addChangeAtBar(head, rows, Number(addBar), kind);
    if (next) setRows(next);
  };

  const tap = () => {
    const next = addTap(taps, performance.now());
    setTaps(next);
    const bpm = tapBpm(next);
    if (bpm !== null) {
      setHeadField({ bpm: clampManualBpm(bpm) });
    }
  };
  const nudgeOffset = (ms: number) => {
    setOffset((o) => roundMs(o + ms / 1000));
  };

  const save = async () => {
    if (!parsed.ok) return;
    setBusy(true);
    try {
      await actions.save({ segments: parsed.segments }, offset);
      notifications.show({ message: t("tempo.saved") });
      onDone();
    } catch (err) {
      notifications.show({ color: "red", message: apiError(err) });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await actions.remove();
      notifications.show({ message: t("tempo.removed") });
      onDone();
    } catch (err) {
      notifications.show({ color: "red", message: apiError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="md">
      <Group grow align="flex-start" wrap="wrap">
        <NumberInput
          label={t("tempo.bpm")}
          value={head.bpm}
          min={MANUAL_MIN_BPM}
          max={MANUAL_MAX_BPM}
          decimalScale={3}
          step={1}
          onChange={(v) => {
            setHeadField({ bpm: v });
          }}
          miw={120}
          data-testid="tempo-bpm"
        />
        <Autocomplete
          label={t("tempo.timeSignature")}
          data={METER_PRESETS}
          value={head.meter}
          onChange={(v) => {
            setHeadField({ meter: v });
          }}
          error={parseMeter(head.meter) ? undefined : t("tempo.errors.meter")}
          miw={120}
          data-testid="tempo-meter"
        />
      </Group>
      <Group gap="xs" wrap="wrap">
        <Button {...BTN} variant="light" onClick={tap} data-testid="tempo-tap">
          {tapBpm(taps) !== null ? t("tempo.tapBpm", { bpm: tapBpm(taps) }) : t("tempo.tap")}
        </Button>
        <Text size="xs" c="dimmed" style={{ flex: "1 1 160px" }}>
          {t("tempo.tapHint")}
        </Text>
      </Group>

      <Stack gap={6}>
        <NumberInput
          label={t("tempo.offset")}
          description={t("tempo.offsetHint")}
          value={offset}
          decimalScale={3}
          step={0.001}
          min={-60}
          max={3600}
          onChange={(v) => {
            setOffset(offsetFromInput(v));
          }}
          data-testid="tempo-offset"
        />
        <Group gap={6} wrap="wrap">
          {[-10, -1, 1, 10].map((ms) => (
            <Button
              key={ms}
              {...BTN}
              size="xs"
              variant="default"
              onClick={() => {
                nudgeOffset(ms);
              }}
              data-testid={`tempo-offset-${ms}`}
            >
              {t("tempo.ms", { ms: ms > 0 ? `+${ms}` : String(ms) })}
            </Button>
          ))}
          <Button
            {...BTN}
            size="xs"
            variant="light"
            color="yellow"
            onClick={() => {
              setOffset(roundMs(positionNow()));
            }}
            data-testid="tempo-align"
          >
            {t("tempo.align")}
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          {t("tempo.alignHint")}
        </Text>
      </Stack>

      <Stack gap={6}>
        <Text fw={600} size="sm">
          {t("tempo.changes")}
        </Text>
        {rows.length > 0 && (
          <Stack gap="xs" data-testid="tempo-changes">
            {rows.map((r) => (
              <ChangeRowEditor
                key={r.id}
                row={r}
                phone={phone}
                invalid={!parsed.ok && parsed.rowId === r.id}
                inEffect={() =>
                  parsed.ok
                    ? inEffectAtBar(parsed.segments, Number(r.bar) || 2)
                    : { bpm: typeof head.bpm === "number" ? head.bpm : 120, meter: head.meter }
                }
                onChange={(patch) => {
                  setRow(r.id, patch);
                }}
                onRemove={() => {
                  setRows((rs) => rs.filter((x) => x.id !== r.id));
                }}
              />
            ))}
          </Stack>
        )}
        <Group gap="xs" align="flex-end" wrap="wrap">
          <NumberInput
            label={t("tempo.atBar")}
            value={addBar}
            min={2}
            max={MAX_EDIT_BAR}
            step={1}
            allowDecimal={false}
            w={110}
            onChange={setAddBar}
            data-testid="tempo-add-bar"
          />
          <Button
            {...BTN}
            variant="default"
            leftSection={<IconPlus size={16} />}
            disabled={!parsed.ok}
            onClick={() => {
              add("tempo");
            }}
            data-testid="tempo-add-change"
          >
            {t("tempo.addTempoChange")}
          </Button>
          <Button
            {...BTN}
            variant="default"
            leftSection={<IconPlus size={16} />}
            disabled={!parsed.ok}
            onClick={() => {
              add("meter");
            }}
            data-testid="tempo-add-meter"
          >
            {t("tempo.addMeterChange")}
          </Button>
        </Group>
      </Stack>

      {!parsed.ok && (
        <Alert color="red" data-testid="tempo-error">
          {t(`tempo.errors.${parsed.error}`)}
        </Alert>
      )}
      <Group justify="space-between">
        {tempo ? (
          <Button
            {...BTN}
            variant="subtle"
            color="red"
            leftSection={<IconTrash size={16} />}
            loading={busy}
            onClick={() => void remove()}
            data-testid="tempo-remove"
          >
            {t("tempo.remove")}
          </Button>
        ) : (
          <span />
        )}
        <Button
          {...BTN}
          disabled={!parsed.ok}
          loading={busy}
          onClick={() => void save()}
          data-testid="tempo-save"
        >
          {t("common.save")}
        </Button>
      </Group>
    </Stack>
  );
}
