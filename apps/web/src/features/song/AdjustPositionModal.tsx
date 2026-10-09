import { SAMPLE_RATE } from "@bandroom/audio-engine";
import {
  MAX_OFFSET_SAMPLES,
  updateTrackVersion,
  type Song,
  type Track,
  type TrackVersion,
} from "@bandroom/shared";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { AppModal } from "../../components/ResponsivePanel";
import { formatOffset } from "../../record/model";
import { NudgeControl } from "../../record/TakeDialog";
import { previewVersionOffset } from "../../rehearse/controller";
import { songKeys } from "../library/queries";

const toMs = (samples: number) => Math.round((samples * 100_000) / SAMPLE_RATE) / 100;
const toSamples = (ms: number) =>
  Math.min(MAX_OFFSET_SAMPLES, Math.max(0, Math.round((ms * SAMPLE_RATE) / 1000)));

/**
 * Adjust position (SPEC §9): moves a version on the timeline in ms steps. The Player plays the
 * new position at once (when it holds the song); Save stores it, Cancel puts it back.
 */
export function AdjustPositionModal({
  song,
  track,
  version,
  onClose,
}: {
  song: Song;
  track: Track;
  version: TrackVersion;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const qc = useQueryClient();
  const original = version.offsetSamples;
  const [samples, setSamples] = useState(original);
  // Whether the Player holds the song and plays the change (it does not move yet).
  const [live, setLive] = useState(() =>
    previewVersionOffset(song.id, track.id, version.id, original),
  );
  const saved = useRef(false);
  const change = (next: number) => {
    setSamples(next);
    setLive(previewVersionOffset(song.id, track.id, version.id, next));
  };
  // Closed without saving: the Player goes back to the stored position.
  useEffect(
    () => () => {
      if (!saved.current) previewVersionOffset(song.id, track.id, version.id, original);
    },
    [song.id, track.id, version.id, original],
  );

  const save = useMutation({
    mutationFn: () =>
      api(updateTrackVersion, { params: { id: version.id }, body: { offsetSamples: samples } }),
    onSuccess: async () => {
      saved.current = true;
      await Promise.all([
        qc.invalidateQueries({ queryKey: songKeys.tracks(song.id) }),
        qc.invalidateQueries({ queryKey: songKeys.allVersions(song.id) }),
      ]);
      onClose();
    },
  });

  return (
    <AppModal opened onClose={onClose} title={t("record.adjust.title")} centered>
      <Stack gap="md" data-testid="adjust-position">
        <Text size="sm">{t("record.adjust.explain", { track: track.name })}</Text>
        <NudgeControl
          label={t("record.adjust.position")}
          value={toMs(samples)}
          min={0}
          onChange={(ms) => {
            change(toSamples(ms));
          }}
        />
        <Text size="xs" c="dimmed" data-testid="adjust-offset" data-offset={samples}>
          {t("record.placedAt", { time: formatOffset(samples) })}
        </Text>
        {!live && (
          <Text size="xs" c="dimmed">
            {t("record.adjust.noPreview")}
          </Text>
        )}
        {save.isError && <Alert color="red">{apiError(save.error)}</Alert>}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" h={44} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            h={44}
            loading={save.isPending}
            disabled={samples === original}
            onClick={() => {
              save.mutate();
            }}
            data-testid="adjust-save"
          >
            {t("common.save")}
          </Button>
        </Group>
      </Stack>
    </AppModal>
  );
}
