import {
  deleteSong,
  listSongGrants,
  removeSongGrant,
  setSongGrant,
  SongTitleSchema,
  updateSong,
  type Song,
  type Track,
} from "@bandroom/shared";
import {
  ActionIcon,
  Alert,
  Button,
  Center,
  Group,
  Loader,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
  VisuallyHidden,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { IconArrowLeft } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../../i18n/format";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { LinksPanel } from "../../links/LinksPanel";
import { api, ApiError } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { zodValidator } from "../../api/validate";
import { ConfirmDeleteModal } from "../../components/ConfirmDeleteModal";
import { GrantsEditor } from "../../components/GrantsEditor";
import { Section } from "../../components/Section";
import { useMixerToggle, type MixerToggle } from "./useMixerToggle";
import { MixerButton } from "./MixerButton";
import { RehearsePanel } from "../../rehearse/RehearsePanel";
import { WhatsNewBanner } from "../../markers/WhatsNewBanner";
import { SongTempoSummary } from "../../tempo/TempoDialog";
import { useTempoUi } from "../../tempo/store";
import { TracksSection } from "./TracksSection";
import { NotFoundPage } from "../../pages/NotFoundPage";
import { songKeys, useInvalidateContent, useSong, useSongTracks } from "../library/queries";
import { FollowButton } from "../../notifications/FollowButton";
import { OfflineButton } from "../../offline/OfflineButton";
import { DocsPanel } from "../../documents/DocsPanel";
import { errorMessage } from "../../api/errorMessage";
import { BackLink } from "../../components/BackLink";
import { dropDeletedFromQueue } from "../../player/dropDeleted";
import { SongLockBanner, SongLockButton } from "./songLock";
import { AppModal } from "../../components/ResponsivePanel";
import {
  EditBanner,
  EditButton,
  EditModeHeader,
  EditModeToolbar,
  useEditingSong,
} from "../../edit/EditMode";
import { useEditSessionSync } from "../../edit/session";
import { useBarLayout, type BarLayout } from "../../rehearse/barLayout";
import {
  closeSongPreferences,
  SONG_SECTION_IDS,
  SongMenuDialogs,
  SongMoreMenu,
  SongPreferencesButton,
  useSongMenuUi,
} from "./SongMenu";

/** Icon buttons of the desktop song header (SPEC §31.2). */
const HEADER_ICON = 36;

/**
 * The compact song header (SPEC §31.2): back link, title (wrapping by words), the song info line
 * and the actions. Phones: a back arrow, the title and a few icons (the rest in "⋯"). Landscape
 * phones: the title stays for screen readers; the control bar has a compact one.
 */
function SongHeader({
  song,
  layout,
  editing,
  actions,
  phoneActions,
}: {
  song: Song;
  layout: BarLayout;
  editing: boolean;
  actions: ReactNode;
  phoneActions: ReactNode;
}) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const meta = [
    song.subtitle,
    song.key && t("songs.keyLabel", { key: song.key }),
    song.bytes ? fmt.bytes(song.bytes) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const back = `/projects/${song.project.id}`;
  const info = (size: "xs" | "sm") => (
    <Group gap={6} wrap="wrap" style={{ rowGap: 0 }}>
      {meta && (
        <Text c="dimmed" size={size} data-testid="song-meta">
          {meta}
        </Text>
      )}
      <SongTempoSummary songId={song.id} />
    </Group>
  );
  if (layout === "landscape") {
    return (
      <VisuallyHidden>
        <Title order={2} data-testid="song-title">
          {song.title}
        </Title>
        {editing && <EditModeHeader song={song} />}
      </VisuallyHidden>
    );
  }
  if (layout === "phone") {
    return (
      <Group gap={2} wrap="nowrap" align="center" data-testid="song-header">
        <Tooltip label={t("songs.backTo", { name: song.project.name })}>
          <ActionIcon
            component={Link}
            to={back}
            size={44}
            variant="subtle"
            aria-label={t("songs.backTo", { name: song.project.name })}
            data-testid="song-back"
          >
            <IconArrowLeft size={20} />
          </ActionIcon>
        </Tooltip>
        <Stack gap={0} style={{ flex: "1 1 auto", minWidth: 0 }}>
          <Title
            order={2}
            size="h4"
            lineClamp={2}
            style={{ overflowWrap: "break-word" }}
            data-testid="song-title"
          >
            {song.title}
          </Title>
          {!editing && info("xs")}
        </Stack>
        {editing ? <EditModeHeader song={song} /> : phoneActions}
      </Group>
    );
  }
  return (
    <Group gap="xs" wrap="wrap" align="center" data-testid="song-header" style={{ rowGap: 4 }}>
      <BackLink to={back}>{song.project.name}</BackLink>
      <Title order={2} size="h3" style={{ overflowWrap: "break-word" }} data-testid="song-title">
        {song.title}
      </Title>
      {info("sm")}
      <Group
        gap={4}
        wrap="wrap"
        justify="flex-end"
        ml="auto"
        style={{ flex: "0 1 auto" }}
        data-testid="song-actions"
      >
        {editing ? <EditModeHeader song={song} /> : actions}
      </Group>
    </Group>
  );
}

/** Song page (SPEC §11.3): metadata, the Player (Mixer in the header), tracks, notes and access. */
export function SongPage() {
  const { t } = useTranslation();
  const { songId = "" } = useParams();
  const query = useSong(songId);
  const tracks = useSongTracks(songId);
  const mixer = useMixerToggle(true, songId);
  // Without tracks the Mixer still has the click lane once the song has a tempo (SPEC §9).
  const hasTempo = useTempoUi((s) => s.songId === songId && s.grid !== null);
  const preferencesOpen = useSongMenuUi((s) => s.preferences);
  const layout = useBarLayout();
  // Leaving the page closes its dialogs (the next song must not open with them).
  useEffect(
    () => () => {
      useSongMenuUi.setState({ offline: false, preferences: false });
    },
    [],
  );
  // Edit mode (SPEC §24.6): the edit bar replaces the header actions; the Mixer is open.
  const editing = useEditingSong(songId);
  useEditSessionSync(songId, tracks.data?.tracks);

  if (query.isPending) {
    return (
      <Center mih={200}>
        <Loader />
      </Center>
    );
  }
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.code === "NOT_FOUND")
      return <NotFoundPage />;
    return <Alert color="red">{errorMessage(t, query.error)}</Alert>;
  }
  const song = query.data.song;
  const caps = new Set(song.access.capabilities);

  return (
    <Stack gap="lg">
      <SongHeader
        song={song}
        layout={layout}
        editing={editing}
        actions={
          <>
            <MixerButton mixer={mixer} disabled={tracks.data?.tracks.length === 0 && !hasTempo} />
            <EditButton song={song} tracks={tracks.data?.tracks ?? null} />
            <OfflineButton
              kind="song"
              id={song.id}
              title={song.title}
              projectId={song.project.id}
              iconOnly
              size={HEADER_ICON}
            />
            <FollowButton target="song" id={song.id} iconOnly size={HEADER_ICON} />
            <SongLockButton song={song} size={HEADER_ICON} />
            <SongPreferencesButton song={song} size={HEADER_ICON} />
            <SongMoreMenu song={song} compact={false} size={HEADER_ICON} />
          </>
        }
        phoneActions={
          <>
            <MixerButton mixer={mixer} disabled={tracks.data?.tracks.length === 0 && !hasTempo} />
            <EditButton song={song} tracks={tracks.data?.tracks ?? null} iconOnly />
            <SongPreferencesButton song={song} size={44} />
            <SongMoreMenu song={song} compact size={44} />
          </>
        }
      />
      {editing && <EditModeToolbar />}

      <SongLockBanner song={song} />
      <EditBanner song={song} tracks={tracks.data?.tracks ?? null} />
      <WhatsNewBanner song={song} />
      <SongPlayer song={song} mixer={editing ? { ...mixer, open: true } : mixer} />
      <TracksSection song={song} />
      <DocsPanel song={song} />

      {song.notes && (
        <Section title={t("songs.fields.notes")}>
          <Text style={{ whiteSpace: "pre-wrap" }}>{song.notes}</Text>
        </Section>
      )}

      {caps.has("link.manage") && <SongLinksSection song={song} />}
      {caps.has("grants.manage") && (
        <div id={SONG_SECTION_IDS.access}>
          <SongAccessSection song={song} />
        </div>
      )}
      {caps.has("song.delete") && (
        <div id={SONG_SECTION_IDS.delete}>
          <DeleteSongSection song={song} />
        </div>
      )}

      {preferencesOpen && <EditSongModal song={song} onClose={closeSongPreferences} />}
      <SongMenuDialogs song={song} />
    </Stack>
  );
}

function EditSongModal({ song, onClose }: { song: Song; onClose: () => void }) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateContent();
  const form = useForm({
    initialValues: { title: song.title, subtitle: song.subtitle, key: song.key, notes: song.notes },
    validate: { title: zodValidator(SongTitleSchema, t) },
  });
  const save = useMutation({
    mutationFn: (body: typeof form.values) => api(updateSong, { params: { id: song.id }, body }),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  return (
    <AppModal opened onClose={onClose} title={t("songs.edit")} centered size="lg">
      <form
        onSubmit={form.onSubmit((v) => {
          save.mutate(v);
        })}
        noValidate
      >
        <Stack>
          {save.isError && <Alert color="red">{apiError(save.error)}</Alert>}
          <TextInput label={t("songs.fields.title")} {...form.getInputProps("title")} />
          <TextInput label={t("songs.fields.subtitle")} {...form.getInputProps("subtitle")} />
          <TextInput
            label={t("songs.fields.key")}
            placeholder={t("songs.fields.keyPlaceholder")}
            {...form.getInputProps("key")}
          />
          <Textarea
            label={t("songs.fields.notes")}
            autosize
            minRows={3}
            maxRows={12}
            {...form.getInputProps("notes")}
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

/** Public links of this song (SPEC §3.5); `?links=1` (notifications) scrolls here. */
function SongLinksSection({ song }: { song: Song }) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const ref = useRef<HTMLDivElement>(null);
  const focus = params.get("links") !== null;
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: "start" });
  }, [focus]);
  return (
    <div ref={ref} id={SONG_SECTION_IDS.links}>
      <Section title={t("links.title")} description={t("links.songExplain")} testId="song-links">
        <LinksPanel owner={{ kind: "song", songId: song.id }} canCreate />
      </Section>
    </div>
  );
}

function SongAccessSection({ song }: { song: Song }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const grants = useQuery({
    queryKey: songKeys.grants(song.id),
    queryFn: ({ signal }) => api(listSongGrants, { params: { id: song.id } }, { signal }),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: songKeys.grants(song.id) });
  };
  return (
    <Section
      title={t("grants.songTitle")}
      description={t("grants.songExplain")}
      testId="song-access"
    >
      <GrantsEditor
        rows={grants.data?.grants}
        loading={grants.isPending}
        error={grants.error}
        inheritLabelKey="grants.inheritProject"
        onSet={(userId, role) =>
          api(setSongGrant, { params: { id: song.id, userId }, body: { role } }).then(refresh)
        }
        onRemove={(userId) =>
          api(removeSongGrant, { params: { id: song.id, userId } }).then(refresh)
        }
      />
    </Section>
  );
}

function DeleteSongSection({ song }: { song: Song }) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const navigate = useNavigate();
  const invalidate = useInvalidateContent();
  const [opened, modal] = useDisclosure(false);
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api(deleteSong, { params: { id: song.id } }),
    onSuccess: () => {
      // Drop the deleted song's queries instead of refetching them into 404s. A failure is shown
      // in the confirm modal (`error`).
      qc.removeQueries({ queryKey: songKeys.detail(song.id) });
      invalidate();
      // The deleted song stops and leaves the queue (SPEC §6.10).
      dropDeletedFromQueue(t, { songIds: [song.id] });
      void navigate(`/projects/${song.project.id}`, { replace: true });
    },
  });
  return (
    <Section title={t("projects.settings.danger")}>
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" c="dimmed" style={{ flex: "1 1 240px" }}>
          {t("songs.deleteExplain")}
        </Text>
        <Button color="red" variant="light" onClick={modal.open} data-testid="delete-song">
          {t("songs.delete")}
        </Button>
      </Group>
      <ConfirmDeleteModal
        opened={opened}
        onClose={modal.close}
        title={t("songs.delete")}
        explanation={t("songs.deleteExplain")}
        name={song.title}
        loading={del.isPending}
        error={del.isError ? apiError(del.error) : null}
        onConfirm={() => {
          del.mutate();
        }}
      />
    </Section>
  );
}

/**
 * The song Player (SPEC §11.3, §27.4): the engine with the personal mix; the header's Mixer
 * button shows or hides the mixer tools and the track lanes while the engine plays on. A song
 * without tracks has it too: tempo, click and the transport, running until Stop (SPEC §9).
 */
function SongPlayer({ song, mixer }: { song: Song; mixer: MixerToggle }) {
  const tracks = useSongTracks(song.id);
  if (tracks.isPending) return <Loader size="sm" />;
  const list = tracks.data?.tracks ?? NO_TRACKS;
  return <RehearsePanel song={song} tracks={list} mixerOpen={mixer.open} songPath={appSongPath} />;
}

const appSongPath = (id: string) => `/songs/${id}`;
/** Stable while the tracks query has no data (the Player re-opens the song on a new array). */
const NO_TRACKS: Track[] = [];
