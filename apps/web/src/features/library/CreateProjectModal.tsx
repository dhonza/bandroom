import { createProject, ProjectNameSchema } from "@bandroom/shared";
import { Alert, Button, Group, Stack, Textarea, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { zodValidator } from "../../api/validate";
import { ColorSwatchPicker, type PaletteColorName } from "../../components/ColorSwatchPicker";
import { useInvalidateContent } from "./queries";
import { AppModal } from "../../components/ResponsivePanel";

export function CreateProjectModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const apiError = useApiError();
  const invalidate = useInvalidateContent();
  const form = useForm({
    initialValues: { name: "", description: "", color: "violet" as PaletteColorName },
    validate: { name: zodValidator(ProjectNameSchema, t) },
  });
  const mutation = useMutation({
    mutationFn: (v: typeof form.values) => api(createProject, { body: v }),
    onSuccess: ({ project }) => {
      invalidate();
      form.reset();
      onClose();
      void navigate(`/projects/${project.id}`);
    },
  });

  return (
    <AppModal opened={opened} onClose={onClose} title={t("projects.create")} centered>
      <form
        onSubmit={form.onSubmit((v) => {
          mutation.mutate(v);
        })}
        noValidate
      >
        <Stack>
          {mutation.isError && <Alert color="red">{apiError(mutation.error)}</Alert>}
          <TextInput
            label={t("projects.fields.name")}
            data-autofocus
            {...form.getInputProps("name")}
          />
          <Textarea
            label={t("projects.fields.description")}
            autosize
            minRows={2}
            maxRows={6}
            {...form.getInputProps("description")}
          />
          <ColorSwatchPicker
            label={t("projects.fields.color")}
            value={form.values.color}
            onChange={(c) => {
              form.setFieldValue("color", c);
            }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={mutation.isPending} data-testid="create-project-submit">
              {t("projects.create")}
            </Button>
          </Group>
        </Stack>
      </form>
    </AppModal>
  );
}
