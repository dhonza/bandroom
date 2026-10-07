import { bounceSong, SongTitleSchema, type Song } from "@bandroom/shared";
import { Alert, Button, Checkbox, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { projectKeys } from "../features/library/queries";
import { useTempoUi } from "../tempo/store";
import { pageState } from "./controller";

export interface BounceOptions {
  copyTempo: boolean;
  copyMarkers: boolean;
  includeClick: boolean;
}

const BOUNCE_OPTION_KEYS = ["copyTempo", "copyMarkers", "includeClick"] as const;

/** The dialog's defaults (owner decisions 2026-10-07, SPEC §5.5). */
export const DEFAULT_BOUNCE_OPTIONS: BounceOptions = {
  copyTempo: true,
  copyMarkers: true,
  includeClick: false,
};

/**
 * What the Player plays right now: the personal mix (with the click settings) and each track's
 * loaded version, and the dialog's options.
 */
export function bounceRequestBody(title: string, options: BounceOptions = DEFAULT_BOUNCE_OPTIONS) {
  const s = pageState();
  return {
    title: title.trim(),
    mix: s.mix,
    versions: Object.fromEntries(s.tracks.map((p) => [p.track.id, p.version.id])),
    ...options,
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
  const [options, setOptions] = useState(DEFAULT_BOUNCE_OPTIONS);
  // The click needs the song's tempo map (SPEC §6.7).
  const hasTempo = useTempoUi((s) => s.songId === song.id && s.tempo !== null);
  const valid = SongTitleSchema.safeParse(title).success;
  const body = () =>
    bounceRequestBody(title, { ...options, includeClick: options.includeClick && hasTempo });
  const run = useMutation({
    mutationFn: () => api(bounceSong, { params: { id: song.id }, body: body() }),
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
        <Stack gap={0}>
          {BOUNCE_OPTION_KEYS.map((key) => {
            const disabledHint = key === "includeClick" && !hasTempo ? t("click.noTempo") : null;
            return (
              <Checkbox
                key={key}
                label={t(`bounce.${key}`)}
                description={disabledHint}
                checked={options[key] && disabledHint === null}
                disabled={disabledHint !== null}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setOptions((o) => ({ ...o, [key]: on }));
                }}
                // 44 px rows: the label is part of the touch target.
                styles={{ body: { minHeight: 44, alignItems: "center" } }}
                data-testid={`bounce-${key}`}
              />
            );
          })}
          <Text size="xs" c="dimmed">
            {t("bounce.alwaysCopied")}
          </Text>
        </Stack>
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
