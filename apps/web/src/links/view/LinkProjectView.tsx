import {
  Alert,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconChevronRight, IconPlayerPlayFilled } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useProjectSongs } from "../../features/library/queries";
import { useProjectQueue, useQueueLoader } from "../../player/useProjectQueue";
import { startQueue, useRehearse } from "../../rehearse/controller";
import { MiniPlayer } from "../../shell/MiniPlayer";
import { useLinkMode } from "../linkMode";
import { errorMessage } from "../../api/errorMessage";

/** A project link: the songs, each opening its player, and "Play all" on the engine queue. */
export function LinkProjectView({ token }: { token: string }) {
  const { t } = useTranslation();
  const view = useLinkMode((s) => s.view);
  const project = view?.project ?? { id: "", name: "", imageHash: null };
  const songs = useProjectSongs(project.id);
  const queue = useProjectQueue(project.id);
  const loader = useQueueLoader();
  const current = useRehearse((s) => (s.open ? s.songId : null));
  const songPath = (id: string) => `/l/${token}/songs/${id}`;

  // Synchronous on purpose: the audio is unlocked inside the tap on iOS (see useProjectQueue).
  const play = (songId?: string) => {
    const items = queue.data;
    if (!items) return;
    const source = {
      kind: "project" as const,
      projectId: project.id,
      projectName: project.name,
      imageHash: project.imageHash,
    };
    if (!startQueue(items, source, loader, songId)) {
      notifications.show({ color: "gray", message: t("listen.nothingToPlay") });
    }
  };

  if (songs.isPending) return <Loader size="sm" />;
  if (songs.isError) return <Alert color="red">{errorMessage(t, songs.error)}</Alert>;
  const list = songs.data.songs;

  return (
    <Stack gap="md" data-testid="link-project">
      <Group justify="space-between" wrap="wrap">
        <Title order={2} style={{ overflowWrap: "anywhere" }}>
          {project.name}
        </Title>
        {list.length > 0 && (
          <Button
            h={44}
            leftSection={<IconPlayerPlayFilled size={16} />}
            loading={queue.isPending}
            onClick={() => {
              play();
            }}
            data-testid="play-all"
          >
            {t("listen.playAll")}
          </Button>
        )}
      </Group>
      {list.length === 0 && <Text c="dimmed">{t("links.view.noSongs")}</Text>}
      <Stack gap="xs">
        {list.map((s) => (
          <Paper key={s.id} withBorder radius="md" data-testid="link-song-row">
            <Group wrap="nowrap" gap={0}>
              <Button
                variant="subtle"
                h={56}
                w={56}
                p={0}
                aria-label={t("links.view.playSong", { title: s.title })}
                onClick={() => {
                  play(s.id);
                }}
                data-testid="link-song-play"
              >
                <IconPlayerPlayFilled size={20} />
              </Button>
              <UnstyledButton
                component={Link}
                to={songPath(s.id)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 56,
                  display: "flex",
                  alignItems: "center",
                }}
                px="sm"
                data-testid="link-song-open"
              >
                <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                  <Text fw={600} truncate>
                    {s.title}
                  </Text>
                  {s.subtitle && (
                    <Text size="xs" c="dimmed" truncate>
                      {s.subtitle}
                    </Text>
                  )}
                </Stack>
                <IconChevronRight size={18} />
              </UnstyledButton>
            </Group>
          </Paper>
        ))}
      </Stack>
      {current && (
        <Paper withBorder radius="md" style={{ position: "sticky", bottom: 8 }}>
          <MiniPlayer songPath={songPath} />
        </Paper>
      )}
    </Stack>
  );
}
