import { effectiveTranspose, updateTrack, type Song, type Track } from "@bandroom/shared";
import { Badge, Switch } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { songKeys } from "../features/library/queries";
import { usePlayerView } from "./controller";

/** Whether the track follows the transposition (single-track songs count as a mix). */
function useTransposes(track: Track): boolean {
  const single = usePlayerView((s) => s.tracks.length === 1);
  return effectiveTranspose(track, { singleTrack: single });
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
  const transposes = useTransposes(track);
  const transposing = useTransposing();
  if (!transposing || transposes) return null;
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

/**
 * "Transpose this track" in the lane settings (editors; band-wide, SPEC §30.3): stored as an
 * explicit override on the track. Frozen by a song lock.
 */
export function TransposeSwitch({ song, track }: { song: Song; track: Track }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const apiError = useApiError();
  const transposes = useTransposes(track);
  const save = useMutation({
    mutationFn: (transpose: boolean) =>
      api(updateTrack, { params: { id: track.id }, body: { transpose } }),
    onError: (err) => {
      notifications.show({ color: "red", message: apiError(err) });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: songKeys.tracks(track.songId) });
    },
  });
  const locked = song.locked !== null;
  return (
    <Switch
      label={t("practice.transposeTrack")}
      description={locked ? t("songs.lock.locked") : undefined}
      checked={transposes}
      disabled={locked || save.isPending}
      onChange={(e) => {
        save.mutate(e.currentTarget.checked);
      }}
      data-testid="track-transpose"
    />
  );
}
