import { TrackNameSchema, updateTrack, type Track } from "@bandroom/shared";
import { Alert, Button, Group, Modal, Stack, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { zodValidator } from "../../api/validate";
import { ColorSwatchPicker } from "../../components/ColorSwatchPicker";
import { songKeys } from "../library/queries";

export function TrackEditModal({ track, onClose }: { track: Track; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const apiError = useApiError();
  const form = useForm({
    initialValues: {
      name: track.name,
      color: track.color,
      instrumentTag: track.instrumentTag,
    },
    validate: { name: zodValidator(TrackNameSchema, t) },
  });
  const save = useMutation({
    mutationFn: (v: typeof form.values) =>
      api(updateTrack, {
        params: { id: track.id },
        body: {
          name: v.name,
          color: v.color,
          instrumentTag: v.instrumentTag.trim(),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: songKeys.detail(track.songId) });
      onClose();
    },
  });
  return (
    <Modal opened onClose={onClose} title={t("tracks.edit")} centered>
      <form
        onSubmit={form.onSubmit((v) => {
          save.mutate(v);
        })}
        noValidate
      >
        <Stack>
          {save.isError && <Alert color="red">{apiError(save.error)}</Alert>}
          <TextInput
            label={t("tracks.fields.name")}
            data-autofocus
            {...form.getInputProps("name")}
          />
          <ColorSwatchPicker
            label={t("projects.fields.color")}
            value={form.values.color}
            onChange={(c) => {
              form.setFieldValue("color", c);
            }}
          />
          <TextInput
            label={t("tracks.fields.instrument")}
            description={t("tracks.fields.instrumentHint")}
            maxLength={40}
            {...form.getInputProps("instrumentTag")}
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
