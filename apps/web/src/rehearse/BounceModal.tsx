import { bounceSong, SongTitleSchema, type Song } from "@bandroom/shared";
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { projectKeys } from "../features/library/queries";
import { useRehearse } from "./controller";

/** What the Player plays right now: the personal mix and each track's loaded version. */
export function bounceRequestBody(title: string) {
  const s = useRehearse.getState();
  return {
    title: title.trim(),
    mix: s.mix,
    versions: Object.fromEntries(s.tracks.map((p) => [p.track.id, p.version.id])),
  };
}

/**
 * "Bounce to new song…" (SPEC §5.5, §27.5): the server renders the mix the user hears (mutes,
 * solos, volumes, pans, the versions in the Player) into a new song after this one. On success a
 * notification links to it; it shows its processing badge until the render is ready.
 */
export function BounceModal({
  song,
  opened,
  onClose,
  fullScreen,
}: {
  song: Pick<Song, "id" | "title">;
  opened: boolean;
  onClose: () => void;
  fullScreen: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t("bounce.title")}
      fullScreen={fullScreen}
      centered
    >
      {/* Mounted per opening, so the title starts from the default each time. */}
      {opened && <BounceForm song={song} onClose={onClose} />}
    </Modal>
  );
}

function BounceForm({ song, onClose }: { song: Pick<Song, "id" | "title">; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const apiError = useApiError();
  const [title, setTitle] = useState(() =>
    t("bounce.defaultTitle", { title: song.title }).slice(0, 200),
  );
  const valid = SongTitleSchema.safeParse(title).success;
  const run = useMutation({
    mutationFn: () => api(bounceSong, { params: { id: song.id }, body: bounceRequestBody(title) }),
    onSuccess: ({ song: created }) => {
      void qc.invalidateQueries({ queryKey: projectKeys.all });
      onClose();
      const id = `bounce-${created.id}`;
      notifications.show({
        id,
        color: "teal",
        autoClose: 10_000,
        title: t("bounce.started"),
        message: (
          <Button
            variant="light"
            mt={4}
            mih={44}
            h="auto"
            py={6}
            // Long titles wrap instead of overflowing the notification.
            styles={{ label: { whiteSpace: "normal", overflowWrap: "anywhere" } }}
            data-testid="bounce-open"
            onClick={() => {
              notifications.hide(id);
              void navigate(`/songs/${created.id}`);
            }}
          >
            {t("bounce.open", { title: created.title })}
          </Button>
        ),
      });
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !run.isPending) run.mutate();
      }}
    >
      <Stack gap="md">
        <Text size="sm">{t("bounce.explain")}</Text>
        <TextInput
          label={t("bounce.name")}
          value={title}
          maxLength={200}
          data-autofocus
          onChange={(e) => {
            setTitle(e.currentTarget.value);
          }}
          data-testid="bounce-title"
        />
        {run.isError && <Alert color="red">{apiError(run.error)}</Alert>}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose} mih={44}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            disabled={!valid}
            loading={run.isPending}
            mih={44}
            data-testid="bounce-submit"
          >
            {t("bounce.submit")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
