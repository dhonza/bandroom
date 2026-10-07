import { listTrackVersions, type Song, type Track, type TrackVersion } from "@bandroom/shared";
import {
  ActionIcon,
  Alert,
  Center,
  Group,
  Loader,
  Menu,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api/client";
import { Section } from "../../components/Section";
import { songKeys, useSong, useSongTracks } from "../../features/library/queries";
import { MixerButton } from "../../features/song/MixerButton";
import { useMixerToggle } from "../../features/song/useMixerToggle";
import { downloadUrl, formatDuration } from "../../lib/media";
import { useRehearse } from "../../rehearse/controller";
import { RehearsePanel } from "../../rehearse/RehearsePanel";
import { MiniPlayer } from "../../shell/MiniPlayer";
import { SongTempoSummary } from "../../tempo/TempoDialog";
import { useLinkMode } from "../linkMode";
import { errorMessage } from "../../api/errorMessage";
import { BackLink } from "../../components/BackLink";

/**
 * A song through a public link (SPEC §11.2): the song page's player with the Mixer for every
 * visitor (SPEC §27), comments as the link allows, and downloads by policy.
 */
export function LinkSongView({ songId, token }: { songId: string; token: string }) {
  const { t } = useTranslation();
  const view = useLinkMode((s) => s.view);
  const q = useSong(songId);
  const tracksQ = useSongTracks(songId);
  // Every visitor may open the Mixer (SPEC §27); it starts closed and is not remembered.
  const mixer = useMixerToggle(false);
  // Another song of the project plays on while this page shows its song (SPEC §6.10).
  const elsewhere = useRehearse((s) => s.open && s.songId !== songId);

  if (q.isPending || tracksQ.isPending || !view) {
    return (
      <Center mih={200}>
        <Loader />
      </Center>
    );
  }
  if (q.isError || tracksQ.isError) {
    const notFound = q.error instanceof ApiError && q.error.code === "NOT_FOUND";
    return (
      <Alert color={notFound ? "gray" : "red"}>
        {notFound ? t("links.view.songMissing") : errorMessage(t, q.error ?? tracksQ.error)}
      </Alert>
    );
  }
  const song = q.data.song;
  const tracks = tracksQ.data.tracks;
  return (
    <Stack gap="lg" data-testid="link-song">
      {view.songId === null && <BackLink to={`/l/${token}`}>{view.project.name}</BackLink>}
      {/* Long titles wrap by words; on narrow screens the button wraps below (SPEC §11.3). */}
      <Group justify="space-between" align="flex-start" wrap="wrap" data-testid="song-header">
        <Stack gap={2} style={{ flex: "1 1 12rem", minWidth: 0 }}>
          <Title order={2} style={{ overflowWrap: "break-word" }} data-testid="link-song-title">
            {song.title}
          </Title>
          {(song.subtitle || song.key) && (
            <Text c="dimmed">
              {[song.subtitle, song.key && t("songs.keyLabel", { key: song.key })]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          )}
          <SongTempoSummary songId={song.id} />
        </Stack>
        <Group gap="xs" wrap="wrap" justify="flex-end" style={{ flex: "0 1 auto" }}>
          <MixerButton mixer={mixer} disabled={tracks.length === 0} />
        </Group>
      </Group>
      {tracks.length > 0 ? (
        <RehearsePanel
          key={song.id}
          song={song}
          tracks={tracks}
          mixerOpen={mixer.open}
          {...(view.songId === null && { songPath: (id: string) => `/l/${token}/songs/${id}` })}
        />
      ) : (
        // Nothing to hear yet (no tracks).
        <Alert color="gray" data-testid="link-mix-preparing">
          {t("links.view.nothingYet")}
        </Alert>
      )}
      {song.access.capabilities.includes("download") && tracks.length > 0 && (
        <LinkDownloads song={song} tracks={tracks} allVersions={view.versions === "all"} />
      )}
      {elsewhere && view.songId === null && (
        <Paper withBorder radius="md" style={{ position: "sticky", bottom: 8 }}>
          <MiniPlayer songPath={(id) => `/l/${token}/songs/${id}`} />
        </Paper>
      )}
    </Stack>
  );
}

/** Downloads allowed by the link and the download policy (SPEC §3.4, §3.5). */
function LinkDownloads({
  song,
  tracks,
  allVersions,
}: {
  song: Song;
  tracks: Track[];
  allVersions: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Section title={t("links.view.downloads")} testId="link-downloads">
      <Stack gap="xs">
        {tracks.map((tr) =>
          allVersions && tr.versionCount > 1 ? (
            <TrackVersionDownloads key={tr.id} song={song} track={tr} />
          ) : (
            tr.current && (
              <DownloadRow key={tr.id} name={tr.name} version={tr.current} showNumber={false} />
            )
          ),
        )}
      </Stack>
    </Section>
  );
}

function TrackVersionDownloads({ song, track }: { song: Song; track: Track }) {
  const q = useQuery({
    queryKey: songKeys.versions(song.id, track.id),
    queryFn: ({ signal }) => api(listTrackVersions, { params: { id: track.id } }, { signal }),
  });
  return (
    <Stack gap={4}>
      {(q.data?.versions ?? []).map((v) => (
        <DownloadRow key={v.id} name={track.name} version={v} showNumber />
      ))}
    </Stack>
  );
}

function DownloadRow({
  name,
  version,
  showNumber,
}: {
  name: string;
  version: TrackVersion;
  showNumber: boolean;
}) {
  const { t } = useTranslation();
  if (version.downloads.length === 0) return null;
  return (
    <Group justify="space-between" wrap="nowrap" data-testid="link-download-row">
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Text fw={600} truncate>
          {name}
          {showNumber ? ` · v${version.number}` : ""}
        </Text>
        <Text size="xs" c="dimmed" truncate>
          {[version.label, version.media && formatDuration(version.media.durationSec)]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </Stack>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            aria-label={t("links.view.downloadTrack", { name })}
            data-testid="link-download-menu"
          >
            <IconDownload size={20} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          {version.downloads.map((f) => (
            <Menu.Item
              key={f}
              component="a"
              href={downloadUrl(version.id, f)}
              download
              leftSection={<IconDownload size={16} />}
              data-testid={`download-${f}`}
            >
              {t(`tracks.download.${f}`)}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}
