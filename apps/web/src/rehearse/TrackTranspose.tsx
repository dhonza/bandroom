import {
  trackStretchPolicy,
  updateTrack,
  type FormantMode,
  type MixerTrackState,
  type Song,
  type Track,
} from "@bandroom/shared";
import { Badge, Divider, SegmentedControl, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { songKeys } from "../features/library/queries";
import { setTrack, usePlayerView } from "./controller";
import { FormantFields } from "./FormantFields";

/** The track's resolved practice policy for this listener (band default + personal override). */
function usePolicy(track: Track) {
  const single = usePlayerView((s) => s.tracks.length === 1);
  const personal = usePlayerView((s) => s.mix.tracks[track.id]);
  return trackStretchPolicy(track, personal, { singleTrack: single });
}

/** A transposition is active for the open song. */
function useTransposing(): boolean {
  return usePlayerView((s) => {
    const p = s.mix.practice;
    return (p?.semitones ?? 0) !== 0 || (p?.cents ?? 0) !== 0;
  });
}

/** "Keeps its pitch" on a lane while the song is transposed (SPEC §30.6). */
export function PitchLockedBadge({ track }: { track: Track }) {
  const { t } = useTranslation();
  const { transpose } = usePolicy(track);
  const transposing = useTransposing();
  if (!transposing || transpose) return null;
  return (
    <Badge
      variant="outline"
      color="teal"
      size="sm"
      style={{ flex: "none" }}
      data-testid="pitch-locked"
    >
      {t("practice.pitchLocked")}
    </Badge>
  );
}

type Tri = "auto" | "on" | "off";
const triOf = (v: boolean | null | undefined, empty: Tri = "auto"): Tri =>
  v === null || v === undefined ? empty : v ? "on" : "off";

/**
 * Practice settings in a lane's settings (SPEC §30.3): the band default (editors; saved on the
 * track, frozen by a song lock) and "For me" (everyone; saved with the personal mix, null = the
 * band default).
 */
export function TrackPracticeSettings({
  song,
  track,
  canEdit,
}: {
  song: Song;
  track: Track;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const personal = usePlayerView((s) => s.mix.tracks[track.id]);
  const policy = usePolicy(track);
  return (
    <Stack gap="sm" data-testid="track-practice">
      {canEdit && <BandDefaults song={song} track={track} />}
      {canEdit && <Divider />}
      <Text size="sm" fw={600}>
        {t("practice.forMe")}
      </Text>
      <PersonalSettings track={track} personal={personal} />
      <Text size="xs" c="dimmed" data-testid="track-practice-summary">
        {t("practice.resolved", {
          transpose: t(policy.transpose ? "instruments.on" : "instruments.off"),
          formants: t(`practice.formantModes.${policy.formant ? "preserve" : "follow"}`),
          shift: t("practice.semitonesShort", {
            value:
              policy.formantShift > 0 ? `+${policy.formantShift}` : String(policy.formantShift),
          }),
        })}
      </Text>
    </Stack>
  );
}

function BandDefaults({ song, track }: { song: Song; track: Track }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const apiError = useApiError();
  const [shift, setShift] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: (
      body: Partial<{
        transpose: boolean | null;
        formantMode: FormantMode | null;
        formantShift: number;
      }>,
    ) => api(updateTrack, { params: { id: track.id }, body }),
    onError: (err) => {
      notifications.show({ color: "red", message: apiError(err) });
    },
    onSettled: () => {
      setShift(null);
      void qc.invalidateQueries({ queryKey: songKeys.tracks(track.songId) });
    },
  });
  const locked = song.locked !== null;
  const disabled = locked || save.isPending;
  return (
    <Stack gap={6} data-testid="track-band-defaults">
      <Text size="sm" fw={600}>
        {t("practice.bandDefault")}
      </Text>
      <Text size="sm" fw={500}>
        {t("tracks.fields.transpose")}
      </Text>
      <SegmentedControl
        fullWidth
        size="xs"
        disabled={disabled}
        value={triOf(track.transpose)}
        onChange={(v) => {
          save.mutate({ transpose: v === "auto" ? null : v === "on" });
        }}
        data={(["auto", "on", "off"] as const).map((x) => ({
          value: x,
          label: t(x === "auto" ? "instruments.automatic" : `instruments.${x}`),
        }))}
        data-testid="track-transpose"
      />
      <FormantFields
        mode={track.formantMode ?? "auto"}
        shift={shift ?? track.formantShift}
        onMode={(m) => {
          if (m !== "band") save.mutate({ formantMode: m === "auto" ? null : m });
        }}
        onShift={setShift}
        onShiftEnd={(x) => {
          save.mutate({ formantShift: x ?? 0 });
        }}
        disabled={disabled}
        note={locked ? t("songs.lock.locked") : undefined}
        testId="track-band"
      />
    </Stack>
  );
}

function PersonalSettings({
  track,
  personal,
}: {
  track: Track;
  personal: MixerTrackState | undefined;
}) {
  const { t } = useTranslation();
  const [shift, setShift] = useState<number | null | undefined>(undefined);
  const set = (patch: Partial<MixerTrackState>) => {
    setTrack(track.id, patch);
  };
  const own = shift === undefined ? (personal?.formantShift ?? null) : shift;
  return (
    <Stack gap={6} data-testid="track-personal">
      <Text size="sm" fw={500}>
        {t("tracks.fields.transpose")}
      </Text>
      <SegmentedControl
        fullWidth
        size="xs"
        value={
          personal?.transpose === null || personal?.transpose === undefined
            ? "band"
            : triOf(personal.transpose)
        }
        onChange={(v) => {
          set({ transpose: v === "band" ? null : v === "on" });
        }}
        data={(["band", "on", "off"] as const).map((x) => ({
          value: x,
          label: t(x === "band" ? "practice.formantModes.band" : `instruments.${x}`),
        }))}
        data-testid="track-my-transpose"
      />
      <FormantFields
        personal
        mode={personal?.formantMode ?? "band"}
        shift={own}
        onMode={(m) => {
          set({ formantMode: m === "band" ? null : m });
        }}
        onShift={setShift}
        onShiftEnd={(x) => {
          setShift(undefined);
          set({ formantShift: x });
        }}
        testId="track-my"
      />
    </Stack>
  );
}
