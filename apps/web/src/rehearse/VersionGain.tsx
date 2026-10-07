import { updateTrackVersion, type Song, type Track, type TrackVersion } from "@bandroom/shared";
import { Badge, NumberInput, Stack, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { songKeys } from "../features/library/queries";
import { setVersionGain } from "./controller";

/** "+3 dB" / "−1.5 dB" for a version gain (SPEC §25.6). */
export function formatGain(db: number, t: TFunction): string {
  const v = Math.round(db * 100) / 100;
  return t("rehearse.db", { value: v > 0 ? `+${v}` : String(v) });
}

/** The typed value as a gain, or null when it is not a number. */
export function parseGain(value: string | number): number | null {
  const n = typeof value === "number" ? value : Number(value.replace(",", ".").replace("−", "-"));
  return value !== "" && Number.isFinite(n) ? n : null;
}

/** Small badge beside the track name when the playing version has a gain (everyone sees it). */
export function VersionGainBadge({ version }: { version: TrackVersion }) {
  const { t } = useTranslation();
  if (version.gainDb === 0) return null;
  const label = t("rehearse.versionGainBadge", {
    number: version.number,
    value: formatGain(version.gainDb, t),
  });
  return (
    <Tooltip label={label}>
      <Badge
        variant="outline"
        color="gray"
        size="sm"
        tt="none"
        style={{ flex: "none" }}
        aria-label={label}
        data-testid="version-gain-badge"
      >
        {formatGain(version.gainDb, t)}
      </Badge>
    </Tooltip>
  );
}

/**
 * The gain of the version a track plays (SPEC §25.6), typed in dB with no fixed range. Applied
 * before the fader and pan, in the automatic mix and to the waveform. Editors of the track change
 * it; others see the value.
 */
export function VersionGainField({
  song,
  track,
  version,
  canEdit,
}: {
  song: Song;
  track: Track;
  version: TrackVersion;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const apiError = useApiError();
  const [draft, setDraft] = useState<string | number | null>(null);
  const save = useMutation({
    mutationFn: (gainDb: number) =>
      api(updateTrackVersion, { params: { id: version.id }, body: { gainDb } }),
    onError: (err) => {
      notifications.show({ color: "red", message: apiError(err) });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: songKeys.tracks(song.id) });
      void qc.invalidateQueries({ queryKey: songKeys.versions(song.id, track.id) });
    },
  });
  const label = t("rehearse.versionGain", { number: version.number });
  if (!canEdit) {
    return (
      <Stack gap={2}>
        <Text size="xs" fw={600}>
          {label}
        </Text>
        <Text size="sm" data-testid="version-gain-value">
          {formatGain(version.gainDb, t)}
        </Text>
      </Stack>
    );
  }
  // The version gain is frozen while the song is locked (SPEC §25.12).
  const locked = song.locked !== null;
  const commit = () => {
    if (draft === null || locked) return;
    const gain = parseGain(draft);
    setDraft(null);
    if (gain === null || gain === version.gainDb) return;
    setVersionGain(track.id, version.id, gain);
    save.mutate(gain);
  };
  return (
    <NumberInput
      label={label}
      description={locked ? t("songs.lock.locked") : t("rehearse.versionGainHint")}
      disabled={locked}
      size="sm"
      styles={{ input: { minHeight: 44 } }}
      value={draft ?? version.gainDb}
      onChange={setDraft}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(null);
      }}
      step={0.5}
      decimalScale={2}
      allowDecimal
      allowNegative
      clampBehavior="none"
      // The spin buttons would be far below 44 px (touch targets); arrow keys still step.
      hideControls
      inputMode="decimal"
      suffix=" dB"
      aria-label={t("rehearse.versionGainFor", { track: track.name, number: version.number })}
      data-testid="version-gain"
    />
  );
}
