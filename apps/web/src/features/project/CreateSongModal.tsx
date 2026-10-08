import { createSong, SongTitleSchema } from "@bandroom/shared";
import { Alert, Button, Group, Stack, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { zodValidator } from "../../api/validate";
import { useInvalidateContent } from "../library/queries";
import { AppModal } from "../../components/ResponsivePanel";

export function CreateSongModal({
  projectId,
  opened,
  onClose,
}: {
  projectId: string;
  opened: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateContent();
  const form = useForm({
    initialValues: { title: "", subtitle: "", key: "" },
    validate: { title: zodValidator(SongTitleSchema, t) },
  });
  const mutation = useMutation({
    mutationFn: (v: typeof form.values) => api(createSong, { params: { id: projectId }, body: v }),
    onSuccess: () => {
      invalidate();
      form.reset();
      onClose();
    },
  });
  return (
    <AppModal opened={opened} onClose={onClose} title={t("songs.create")} centered>
      <form
        onSubmit={form.onSubmit((v) => {
          mutation.mutate(v);
        })}
        noValidate
      >
        <Stack>
          {mutation.isError && <Alert color="red">{apiError(mutation.error)}</Alert>}
          <TextInput
            label={t("songs.fields.title")}
            data-autofocus
            {...form.getInputProps("title")}
          />
          <TextInput label={t("songs.fields.subtitle")} {...form.getInputProps("subtitle")} />
          <TextInput
            label={t("songs.fields.key")}
            placeholder={t("songs.fields.keyPlaceholder")}
            {...form.getInputProps("key")}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={mutation.isPending} data-testid="create-song-submit">
              {t("songs.create")}
            </Button>
          </Group>
        </Stack>
      </form>
    </AppModal>
  );
}
