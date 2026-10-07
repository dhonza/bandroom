import { changePassword, PasswordSchema } from "@bandroom/shared";
import { Button, Group, PasswordInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { translateValidation, useApiError } from "../../api/useApiError";
import { zodValidator } from "../../api/validate";
import { Section } from "../../components/Section";
import { SESSIONS_QUERY_KEY } from "./SessionsSection";

export function PasswordSection() {
  const { t } = useTranslation();
  const apiError = useApiError();
  const queryClient = useQueryClient();
  const form = useForm({
    initialValues: { currentPassword: "", newPassword: "", confirm: "" },
    validate: {
      currentPassword: (v) => (v ? null : t("validation.required")),
      newPassword: zodValidator(PasswordSchema, t),
      confirm: (v, values) =>
        v === values.newPassword ? null : translateValidation(t, "PASSWORDS_DIFFER"),
    },
  });
  const mutation = useMutation({
    mutationFn: (v: typeof form.values) =>
      api(changePassword, {
        body: { currentPassword: v.currentPassword, newPassword: v.newPassword },
      }),
    onSuccess: () => {
      form.reset();
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      notifications.show({ color: "teal", message: t("settings.password.changed") });
    },
    onError: (err) => {
      form.setFieldError("currentPassword", apiError(err));
    },
  });

  return (
    <Section
      title={t("settings.password.title")}
      description={t("settings.password.description")}
      testId="settings-password"
    >
      <form
        onSubmit={form.onSubmit((v) => {
          mutation.mutate(v);
        })}
        noValidate
      >
        <PasswordInput
          label={t("auth.fields.currentPassword")}
          autoComplete="current-password"
          mb="sm"
          {...form.getInputProps("currentPassword")}
        />
        <PasswordInput
          label={t("auth.fields.newPassword")}
          autoComplete="new-password"
          mb="sm"
          {...form.getInputProps("newPassword")}
        />
        <PasswordInput
          label={t("auth.fields.confirmPassword")}
          autoComplete="new-password"
          {...form.getInputProps("confirm")}
        />
        <Group justify="flex-end" mt="md">
          <Button type="submit" loading={mutation.isPending}>
            {t("settings.password.submit")}
          </Button>
        </Group>
      </form>
    </Section>
  );
}
