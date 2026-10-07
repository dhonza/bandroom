import {
  getSongListen,
  linkPlayerMode,
  listTrackVersions,
  type Song,
  type Track,
  type TrackVersion,
} from "@bandroom/shared";
import { ActionIcon, Alert, Center, Group, Loader, Menu, Stack, Text, Title } from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api/client";
import { Section } from "../../components/Section";
import { songKeys, useSong, useSongTracks } from "../../features/library/queries";
import { ListenPanel } from "../../features/song/ListenPanel";
import { useMixerToggle } from "../../features/song/useMixerToggle";
import { useDefaultMix } from "../../features/song/defaultMix";
import { downloadUrl, formatDuration } from "../../lib/media";
import { RehearsePanel } from "../../rehearse/RehearsePanel";
import { SongTempoSummary } from "../../tempo/TempoDialog";
import { useLinkMode } from "../linkMode";
import { errorMessage } from "../../api/errorMessage";
import { BackLink } from "../../components/BackLink";

/**
 * A song through a public link (SPEC §11.2): the song page's player (Rehearse for all-tracks
 * links, Listen for mix-only links), comments as the link allows, and downloads by policy.
 */
export function LinkSongView({ songId, token }: { songId: string; token: string }) {
  const { t } = useTranslation();
  const view = useLinkMode((s) => s.view);
  const q = useSong(songId);
  const tracksQ = useSongTracks(songId);

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
      <Stack gap={2}>
        <Title order={2} style={{ overflowWrap: "anywhere" }} data-testid="link-song-title">
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
      <LinkPlayer
        key={song.id}
        song={song}
        tracks={tracks}
        initial={linkPlayerMode(view, tracks.length)}
        canSwitch={view.content === "all-tracks" && tracks.length > 0}
      />
      {song.access.capabilities.includes("download") && tracks.length > 0 && (
        <LinkDownloads song={song} tracks={tracks} allVersions={view.versions === "all"} />
      )}
    </Stack>
  );
}

/**
 * The song page's player for link visitors: the Mixer button only on all-tracks links; the
 * initial state follows the link and is not stored for visitors.
 */
function LinkPlayer({
  song,
  tracks,
  initial,
  canSwitch,
}: {
  song: Song;
  tracks: Track[];
  initial: "listen" | "rehearse";
  canSwitch: boolean;
}) {
  const { t } = useTranslation();
  const mixer = useMixerToggle(song, {
    ready: true,
    remember: false,
    decide: () => initial === "rehearse",
  });
  const listenQ = useQuery({
    queryKey: songKeys.listen(song.id),
    queryFn: ({ signal }) => api(getSongListen, { params: { id: song.id } }, { signal }),
  });
  const defaultMix = useDefaultMix(song, mixer, tracks);
  if (mixer.open === null) return <Loader size="sm" />;
  const toggle = canSwitch ? mixer : undefined;
  if ((mixer.open || defaultMix) && tracks.length > 0) {
    return <RehearsePanel song={song} tracks={tracks} mixer={toggle} defaultMix={defaultMix} />;
  }
  // Nothing to hear in the mix player yet (no tracks and no mix).
  if (tracks.length === 0 && listenQ.isSuccess && listenQ.data.listen === null) {
    return (
      <Alert color="gray" data-testid="link-mix-preparing">
        {t("links.view.mixPreparing")}
      </Alert>
    );
  }
  return <ListenPanel song={song} tracks={tracks} mixer={toggle} />;
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
