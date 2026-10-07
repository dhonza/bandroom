import { DisplayNameSchema, EmailSchema } from "@bandroom/shared";
import { Button, Group, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { useApiError } from "../../api/useApiError";
import { zodValidator } from "../../api/validate";
import { useCurrentUser } from "../../auth/session";
import { useUpdateMe } from "../../auth/useAccount";
import { Section } from "../../components/Section";

export function ProfileSection() {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const update = useUpdateMe();
  const apiError = useApiError();
  const emailValidator = zodValidator(EmailSchema, t, "EMAIL");

  const form = useForm({
    initialValues: { displayName: user.displayName, email: user.email ?? "" },
    validate: {
      displayName: zodValidator(DisplayNameSchema, t),
      email: (v) => (v.trim() === "" ? null : emailValidator(v)),
    },
  });

  return (
    <Section title={t("settings.profile.title")} testId="settings-profile">
      <form
        onSubmit={form.onSubmit((v) => {
          update.mutate(
            { displayName: v.displayName, email: v.email.trim() === "" ? null : v.email },
            {
              onSuccess: () => {
                form.resetDirty();
                notifications.show({ color: "teal", message: t("settings.saved") });
              },
              onError: (err) => {
                form.setFieldError("email", apiError(err));
              },
            },
          );
        })}
        noValidate
      >
        <TextInput label={t("auth.fields.username")} value={user.username} disabled mb="sm" />
        <TextInput
          label={t("auth.fields.displayName")}
          mb="sm"
          {...form.getInputProps("displayName")}
        />
        <TextInput
          label={t("auth.fields.emailOptional")}
          description={t("settings.profile.emailHint")}
          type="email"
          autoCapitalize="none"
          {...form.getInputProps("email")}
        />
        <Group justify="flex-end" mt="md">
          <Button type="submit" loading={update.isPending} disabled={!form.isDirty()}>
            {t("common.save")}
          </Button>
        </Group>
      </form>
    </Section>
  );
}
