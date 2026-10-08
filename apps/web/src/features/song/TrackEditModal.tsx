import {
  INSTRUMENTS,
  InstrumentSchema,
  TrackNameSchema,
  guessInstrument,
  updateTrack,
  type Instrument,
  type Track,
  type VoiceRange,
} from "@bandroom/shared";
import {
  Alert,
  Button,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { zodValidator } from "../../api/validate";
import { ColorSwatchPicker } from "../../components/ColorSwatchPicker";
import { FormantFields } from "../../rehearse/FormantFields";
import { songKeys } from "../library/queries";
import { AppModal } from "../../components/ResponsivePanel";

/** Select value for "automatic" (null in the API). */
const AUTO = "auto";

type TransposeValue = typeof AUTO | "on" | "off";
type VoiceValue = typeof AUTO | "low" | "high";

const transposeOf = (v: boolean | null): TransposeValue => (v === null ? AUTO : v ? "on" : "off");
const transposeFrom = (v: TransposeValue): boolean | null => (v === AUTO ? null : v === "on");
// A stored "auto" voice range is the same as automatic (pitch tracking).
const voiceOf = (v: VoiceRange | null): VoiceValue => (v === "low" || v === "high" ? v : AUTO);
const voiceFrom = (v: VoiceValue): VoiceRange | null => (v === AUTO ? null : v);
const instrumentFrom = (v: string): Instrument | null => {
  const r = InstrumentSchema.safeParse(v);
  return r.success ? r.data : null;
};

/**
 * Track dialog: name, colour, free-text tag, and the band-wide instrument, transpose policy and
 * voice range (SPEC §30.3, §30.6). The last three are frozen by a song lock.
 */
export function TrackEditModal({
  track,
  locked = false,
  singleTrack = false,
  onClose,
}: {
  track: Track;
  /** The song is locked: instrument, transpose and voice range stay read-only. */
  locked?: boolean;
  /** The only track of its song: an unrecognised one is the mix. */
  singleTrack?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const apiError = useApiError();
  const initial = {
    name: track.name,
    color: track.color,
    instrumentTag: track.instrumentTag,
    instrument: track.instrument ?? AUTO,
    transpose: transposeOf(track.transpose),
    voiceRange: voiceOf(track.voiceRange),
    formantMode: track.formantMode ?? "auto",
    formantShift: track.formantShift,
  };
  const form = useForm({
    initialValues: initial,
    validate: { name: zodValidator(TrackNameSchema, t) },
  });
  const v = form.values;
  const guess = guessInstrument(v.name, v.instrumentTag) ?? (singleTrack ? "mix" : "other");
  const effective = instrumentFrom(v.instrument) ?? guess;
  const lockedNote = locked ? t("songs.lock.locked") : undefined;
  const save = useMutation({
    mutationFn: (values: typeof form.values) =>
      api(updateTrack, {
        params: { id: track.id },
        body: {
          name: values.name,
          color: values.color,
          instrumentTag: values.instrumentTag.trim(),
          // Only changed playback fields: a locked song refuses them even when unchanged.
          ...(values.instrument !== initial.instrument && {
            instrument: instrumentFrom(values.instrument),
          }),
          ...(values.transpose !== initial.transpose && {
            transpose: transposeFrom(values.transpose),
          }),
          ...(values.voiceRange !== initial.voiceRange && {
            voiceRange: voiceFrom(values.voiceRange),
          }),
          ...(values.formantMode !== initial.formantMode && {
            formantMode: values.formantMode === "auto" ? null : values.formantMode,
          }),
          ...(values.formantShift !== initial.formantShift && {
            formantShift: values.formantShift,
          }),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: songKeys.detail(track.songId) });
      onClose();
    },
  });
  return (
    <AppModal opened onClose={onClose} title={t("tracks.edit")} centered>
      <form
        onSubmit={form.onSubmit((values) => {
          save.mutate(values);
        })}
        noValidate
      >
        <Stack>
          {save.isError && <Alert color="red">{apiError(save.error)}</Alert>}
          <TextInput
            label={t("tracks.fields.name")}
            data-autofocus
            {...form.getInputProps("name")}
          />
          <ColorSwatchPicker
            label={t("projects.fields.color")}
            value={v.color}
            onChange={(c) => {
              form.setFieldValue("color", c);
            }}
          />
          <Select
            label={t("tracks.fields.instrument")}
            description={lockedNote}
            data-testid="track-instrument"
            allowDeselect={false}
            disabled={locked}
            data={[
              {
                value: AUTO,
                label: t("instruments.automaticGuess", { guess: t(`instruments.${guess}`) }),
              },
              ...INSTRUMENTS.map((i) => ({ value: i, label: t(`instruments.${i}`) })),
            ]}
            {...form.getInputProps("instrument")}
          />
          <TextInput
            label={t("tracks.fields.instrumentTag")}
            description={t("tracks.fields.instrumentTagHint")}
            maxLength={40}
            {...form.getInputProps("instrumentTag")}
          />
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              {t("tracks.fields.transpose")}
            </Text>
            <SegmentedControl
              data-testid="track-transpose"
              disabled={locked}
              value={v.transpose}
              onChange={(x) => {
                form.setFieldValue("transpose", x);
              }}
              data={(["auto", "on", "off"] as const).map((x) => ({
                value: x,
                label: t(x === AUTO ? "instruments.automatic" : `instruments.${x}`),
              }))}
            />
            {lockedNote && (
              <Text size="xs" c="dimmed">
                {lockedNote}
              </Text>
            )}
          </Stack>
          {effective === "vocals" && (
            <Select
              label={t("tracks.fields.voiceRange")}
              description={lockedNote}
              data-testid="track-voice-range"
              allowDeselect={false}
              disabled={locked}
              data={(["auto", "low", "high"] as const).map((x) => ({
                value: x,
                label: t(x === AUTO ? "instruments.automatic" : `instruments.${x}`),
              }))}
              {...form.getInputProps("voiceRange")}
            />
          )}
          <FormantFields
            mode={v.formantMode}
            shift={v.formantShift}
            onMode={(m) => {
              if (m !== "band") form.setFieldValue("formantMode", m);
            }}
            onShift={(x) => {
              form.setFieldValue("formantShift", x ?? 0);
            }}
            disabled={locked}
            note={lockedNote}
            testId="track-formant"
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {t("common.save")}
            </Button>
          </Group>
        </Stack>
      </form>
    </AppModal>
  );
}
