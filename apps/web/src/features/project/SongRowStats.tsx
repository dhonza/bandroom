import type { SongSummary } from "@bandroom/shared";
import { Group, Text } from "@mantine/core";
import type { TFunction } from "i18next";
import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../../i18n/format";
import { formatDuration } from "../../lib/media";
import { ChannelsMark } from "../../rehearse/ChannelsIcon";

/** "7 tracks: 4 stereo, 3 mono" ("3 tracks: 3 stereo" when none is mono). */
export function songChannelsLabel(t: TFunction, c: { stereo: number; mono: number }): string {
  const parts = [
    c.stereo > 0 ? t("songs.channels.stereo", { count: c.stereo }) : null,
    c.mono > 0 ? t("songs.channels.mono", { count: c.mono }) : null,
  ].filter((p): p is string => p !== null);
  return t("songs.channels.summary", {
    tracks: t("songs.channels.tracks", { count: c.stereo + c.mono }),
    parts: parts.join(", "),
  });
}

/**
 * The right-hand meta of a song row (SPEC §11.2), dimmed: length · mono/stereo · size. The length
 * and mark need ready audio; the mark is stereo when any current track plays stereo.
 */
export function SongRowStats({ song, withBytes }: { song: SongSummary; withBytes: boolean }) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const items: { key: string; node: ReactNode }[] = [];
  const c = song.channels;
  const hasAudio = song.durationSec !== undefined && !!c && c.stereo + c.mono > 0;
  if (hasAudio) {
    const duration = formatDuration(song.durationSec ?? 0);
    items.push({
      key: "length",
      node: (
        <Text
          span
          size="xs"
          c="dimmed"
          className="tabular-nums"
          aria-label={t("songs.length", { duration })}
          data-testid="song-length"
        >
          {duration}
        </Text>
      ),
    });
    items.push({
      key: "channels",
      node: (
        <ChannelsMark
          stereo={c.stereo > 0}
          label={songChannelsLabel(t, c)}
          size={12}
          testId="song-channels"
        />
      ),
    });
  }
  if (withBytes && song.bytes) {
    items.push({
      key: "bytes",
      node: (
        <Text span size="xs" c="dimmed" data-testid="song-bytes">
          {fmt.bytes(song.bytes)}
        </Text>
      ),
    });
  }
  if (items.length === 0) return null;
  return (
    <Group gap={4} wrap="nowrap" style={{ flex: "none" }} data-testid="song-row-stats">
      {items.map((it, i) => (
        <Fragment key={it.key}>
          {i > 0 && (
            <Text span size="xs" c="dimmed" aria-hidden>
              ·
            </Text>
          )}
          {it.node}
        </Fragment>
      ))}
    </Group>
  );
}
