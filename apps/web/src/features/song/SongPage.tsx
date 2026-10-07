import {
  deleteSong,
  listSongGrants,
  removeSongGrant,
  setSongGrant,
  SongTitleSchema,
  updateSong,
  type Song,
} from "@bandroom/shared";
import {
  Alert,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { IconPencil } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
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
import { TracksSection } from "./TracksSection";
import { NotFoundPage } from "../../pages/NotFoundPage";
import { songKeys, useInvalidateContent, useSong, useSongTracks } from "../library/queries";
import { FollowButton } from "../../notifications/FollowButton";
import { OfflineButton } from "../../offline/OfflineButton";
import { DocsPanel } from "../../documents/DocsPanel";
import { SongDocumentsSection } from "../../documents/SongDocuments";
import { errorMessage } from "../../api/errorMessage";
import { BackLink } from "../../components/BackLink";
import { dropDeletedFromQueue } from "../../player/dropDeleted";
import { SongLockBanner, SongLockButton } from "./songLock";

/** Song page (SPEC §11.3): metadata, the Player (Mixer in the header), tracks, notes and access. */
export function SongPage() {
  const { t } = useTranslation();
  const { songId = "" } = useParams();
  const query = useSong(songId);
  const tracks = useSongTracks(songId);
  const mixer = useMixerToggle(true);
  const [editOpen, edit] = useDisclosure(false);

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
      <BackLink to={`/projects/${song.project.id}`}>{song.project.name}</BackLink>
      {/* Long titles wrap by words; on narrow screens the buttons wrap below (SPEC §11.3). */}
      <Group justify="space-between" align="flex-start" wrap="wrap" data-testid="song-header">
        <Stack gap={2} style={{ flex: "1 1 12rem", minWidth: 0 }}>
          <Title order={2} style={{ overflowWrap: "break-word" }} data-testid="song-title">
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
          <MixerButton mixer={mixer} disabled={tracks.data?.tracks.length === 0} />
          <OfflineButton kind="song" id={song.id} title={song.title} projectId={song.project.id} />
          <FollowButton target="song" id={song.id} />
          <SongLockButton song={song} />
          {caps.has("edit.any") && (
            <Button
              variant="default"
              h={44}
              leftSection={<IconPencil size={16} />}
              onClick={edit.open}
              data-testid="edit-song"
            >
              {t("common.edit")}
            </Button>
          )}
        </Group>
      </Group>

      <SongLockBanner song={song} />
      <WhatsNewBanner song={song} />
      <SongPlayer song={song} mixer={mixer} />
      <TracksSection song={song} />
      <SongDocumentsSection song={song} />
      <DocsPanel song={song} />

      {song.notes && (
        <Section title={t("songs.fields.notes")}>
          <Text style={{ whiteSpace: "pre-wrap" }}>{song.notes}</Text>
        </Section>
      )}

      {caps.has("link.manage") && <SongLinksSection song={song} />}
      {caps.has("grants.manage") && <SongAccessSection song={song} />}
      {caps.has("song.delete") && <DeleteSongSection song={song} />}

      {editOpen && <EditSongModal song={song} onClose={edit.close} />}
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
    <Modal opened onClose={onClose} title={t("songs.edit")} centered size="lg">
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
    </Modal>
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
    <div ref={ref}>
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
      // The mini player would take over the deleted song once the page is left (SPEC §6.10).
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
 * button shows or hides the mixer tools and the track lanes while the engine plays on.
 */
function SongPlayer({ song, mixer }: { song: Song; mixer: MixerToggle }) {
  const tracks = useSongTracks(song.id);
  if (tracks.isPending) return <Loader size="sm" />;
  const list = tracks.data?.tracks ?? [];
  if (list.length === 0) return null;
  return <RehearsePanel song={song} tracks={list} mixerOpen={mixer.open} />;
}
