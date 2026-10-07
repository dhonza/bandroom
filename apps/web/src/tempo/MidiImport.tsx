import {
  beatToSec,
  compileTempo,
  MAX_MIDI_BYTES,
  parseMidiTempo,
  type MidiTempoImport,
  type Song,
  type SongTempo,
} from "@bandroom/shared";
import { Alert, Button, Checkbox, FileInput, Group, ScrollArea, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconFileMusic } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApiError } from "../api/useApiError";
import { midiWarningKey, tempoSummaryParams, toggled } from "./midi";
import { summarize } from "./model";
import { useTempoActions } from "./queries";
import { barBeatLabel } from "./readout";
import { BTN } from "./styles";

/** Tempo map and markers from a MIDI file (SPEC §7.2). */
export function MidiImport({
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
  const [file, setFile] = useState<File | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [result, setResult] = useState<MidiTempoImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const choose = async (f: File | null) => {
    setFile(f);
    setResult(null);
    setError(null);
    setBytes(null);
    if (!f) return;
    if (f.size > MAX_MIDI_BYTES) {
      setError(t("errors.FILE_TOO_LARGE"));
      return;
    }
    const b = new Uint8Array(await f.arrayBuffer());
    const r = parseMidiTempo(b);
    if (!r.ok) {
      setError(t(`errors.${r.error}`));
      return;
    }
    setBytes(b);
    setResult(r.value);
    setPicked(new Set(r.value.markers.map((_, i) => i)));
  };

  const grid = result
    ? compileTempo({ map: result.map, bar1OffsetSec: result.bar1OffsetSec })
    : null;
  const summary = result ? summarize(result.map) : null;
  const all = result !== null && picked.size === result.markers.length;

  const run = async () => {
    if (!file || !bytes) return;
    setBusy(true);
    try {
      const n = await actions.importMidi(file.name, bytes, [...picked]);
      notifications.show({ message: t("tempo.midi.done", { count: n }) });
      onDone();
    } catch (err) {
      notifications.show({ color: "red", message: apiError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {t("tempo.midi.explain")}
      </Text>
      <FileInput
        label={t("tempo.midi.file")}
        placeholder={t("tempo.midi.pick")}
        accept=".mid,.midi,audio/midi,audio/x-midi"
        leftSection={<IconFileMusic size={16} />}
        value={file}
        onChange={(f) => void choose(f)}
        clearable
        data-testid="tempo-midi-file"
      />
      {error && (
        <Alert color="red" data-testid="tempo-midi-error">
          {error}
        </Alert>
      )}
      {result && summary && grid && (
        <Stack gap="xs" data-testid="tempo-midi-preview">
          <Text size="sm">
            {t("tempo.summary", tempoSummaryParams(summary))}
            {" · "}
            {t("tempo.midi.changes", { count: summary.changes })}
          </Text>
          {result.warnings.map((w, i) => {
            const warning = midiWarningKey(w);
            return (
              <Text key={i} size="sm" c="orange">
                {t(warning.key, warning.params)}
              </Text>
            );
          })}
          {tempo && (
            <Text size="sm" c="dimmed">
              {t("tempo.midi.replaces")}
            </Text>
          )}
          {result.markers.length > 0 && (
            <>
              <Checkbox
                checked={all}
                indeterminate={picked.size > 0 && !all}
                label={t("tempo.midi.importMarkers", { count: result.markers.length })}
                onChange={() => {
                  setPicked(all ? new Set() : new Set(result.markers.map((_, i) => i)));
                }}
                data-testid="tempo-midi-all-markers"
              />
              <ScrollArea.Autosize mah={200} type="auto">
                <Stack gap={4} pl="md">
                  {result.markers.map((m, i) => (
                    <Checkbox
                      key={i}
                      checked={picked.has(i)}
                      label={`${m.name || t("markers.defaultMarkerName", { n: i + 1 })} · ${barBeatLabel(
                        grid,
                        beatToSec(grid, m.beat),
                        (b) => t("tempo.pickup", { beat: b }),
                      )}`}
                      onChange={() => {
                        setPicked((p) => toggled(p, i));
                      }}
                    />
                  ))}
                </Stack>
              </ScrollArea.Autosize>
            </>
          )}
          <Group justify="flex-end">
            <Button
              {...BTN}
              loading={busy}
              onClick={() => void run()}
              data-testid="tempo-midi-import"
            >
              {t("tempo.midi.import")}
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}
