import { listTrackVersions, type Comment, type Track, type TrackVersion } from "@bandroom/shared";
import { Badge, Button, Group, Text } from "@mantine/core";
import { IconVersions } from "@tabler/icons-react";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { songKeys } from "../features/library/queries";
import { listenToVersion, usePlayerView } from "../rehearse/controller";
import { contextDiff } from "./model";

/** Versions loaded now: the Rehearse engine's, else every track's current version (Listen). */
export function useLoadedVersions(songId: string, tracks: readonly Track[]) {
  const rehearseSong = usePlayerView((s) => s.songId);
  const playing = usePlayerView((s) => s.tracks);
  return useMemo(() => {
    const rehearse = rehearseSong === songId && playing.length > 0;
    const out: Record<string, string> = {};
    if (rehearse) for (const p of playing) out[p.track.id] = p.version.id;
    else for (const tr of tracks) if (tr.current) out[tr.id] = tr.current.id;
    return { loaded: out, rehearse };
  }, [rehearseSong, songId, playing, tracks]);
}

/**
 * "Written on Bass v3, Mix v5" when the comment's versions differ from what is loaded, with
 * "Load those versions" in Rehearse mode (SPEC §8). Loading uses the personal "listen to another
 * version" of each track, so the tracks show "not current" until switched back.
 */
export function ContextBadge({
  comment,
  songId,
  tracks,
}: {
  comment: Comment;
  songId: string;
  tracks: readonly Track[];
}) {
  const { t } = useTranslation();
  const { loaded, rehearse } = useLoadedVersions(songId, tracks);
  const diff = contextDiff(comment.context, loaded);
  const queries = useQueries({
    queries: diff.map((d) => ({
      queryKey: songKeys.versions(songId, d.trackId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api(listTrackVersions, { params: { id: d.trackId } }, { signal }),
    })),
  });
  if (diff.length === 0) return null;
  const entries = diff.map((d, i) => {
    const versions: TrackVersion[] = queries[i]?.data?.versions ?? [];
    return {
      ...d,
      track: tracks.find((x) => x.id === d.trackId),
      version: versions.find((v) => v.id === d.versionId),
      versions,
    };
  });
  const known = entries.filter((e) => e.track && e.version);
  // A version deleted (in the Trash or purged) since the comment was written (SPEC §15.3, §26.3).
  const gone = entries.filter((e, i) => e.track && !e.version && queries[i]?.isSuccess);
  if (known.length === 0 && gone.length === 0) return null;
  const label = [
    ...known.map((e) => `${e.track?.name ?? ""} v${String(e.version?.number ?? "?")}`),
    ...gone.map((e) => t("comments.versionDeleted", { track: e.track?.name ?? "" })),
  ].join(", ");
  const load = () => {
    for (const e of known) {
      if (e.version) listenToVersion(e.trackId, e.version, e.versions);
    }
  };
  return (
    <Group gap="xs" wrap="wrap" data-testid="comment-context">
      <Badge variant="light" color="gray" leftSection={<IconVersions size={12} />} tt="none">
        {t("comments.writtenOn", { versions: label })}
      </Badge>
      {known.length === 0 ? null : rehearse ? (
        <Button
          size="compact-sm"
          variant="subtle"
          h={44}
          onClick={load}
          data-testid="comment-load-versions"
        >
          {t("comments.loadVersions")}
        </Button>
      ) : (
        <Text size="xs" c="dimmed">
          {t("comments.loadVersionsHint")}
        </Text>
      )}
    </Group>
  );
}
