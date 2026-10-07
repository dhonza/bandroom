import {
  acceptInvite,
  DisplayNameSchema,
  getInvite,
  LOCALES,
  PasswordSchema,
  UsernameSchema,
  type Locale,
} from "@bandroom/shared";
import { Alert, Button, Loader, PasswordInput, Select, Stack, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../../api/client";
import { fieldErrorsOf, translateValidation, useApiError } from "../../api/useApiError";
import { zodValidator } from "../../api/validate";
import { useSetSessionUser } from "../../auth/session";
import { changeLanguage } from "../../i18n/i18n";
import { AuthLayout } from "./AuthLayout";

export function InvitePage() {
  const { t, i18n } = useTranslation();
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const setUser = useSetSessionUser();
  const apiError = useApiError();

  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: ({ signal }) => api(getInvite, { params: { token } }, { signal }),
    retry: false,
  });

  const form = useForm({
    initialValues: {
      username: "",
      displayName: "",
      password: "",
      confirm: "",
      locale: (i18n.resolvedLanguage ?? "en") as Locale,
    },
    validate: {
      username: zodValidator(UsernameSchema, t),
      displayName: zodValidator(DisplayNameSchema, t),
      password: zodValidator(PasswordSchema, t),
      confirm: (v, values) =>
        v === values.password ? null : translateValidation(t, "PASSWORDS_DIFFER"),
    },
  });

  const mutation = useMutation({
    mutationFn: ({ confirm: _confirm, ...body }: typeof form.values) =>
      api(acceptInvite, { params: { token }, body }),
    onSuccess: ({ user }) => {
      setUser(user);
      void navigate("/", { replace: true });
    },
    onError: (err) => {
      for (const [field, code] of Object.entries(fieldErrorsOf(err))) {
        form.setFieldError(field, translateValidation(t, code));
      }
    },
  });

  if (invite.isPending) {
    return (
      <AuthLayout title={t("auth.invite.title")}>
        <Loader mx="auto" />
      </AuthLayout>
    );
  }
  if (invite.isError) {
    return (
      <AuthLayout title={t("auth.invite.title")}>
        <Alert color="red" data-testid="invite-invalid">
          {apiError(invite.error)}
        </Alert>
        <Button component={Link} to="/login" variant="default">
          {t("auth.login.title")}
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t("auth.invite.title")}
      subtitle={t("auth.invite.subtitle", { role: t(`roles.${invite.data.globalRole}`) })}
    >
      <form
        onSubmit={form.onSubmit((v) => {
          mutation.mutate(v);
        })}
        noValidate
      >
        <Stack>
          {mutation.isError && Object.keys(fieldErrorsOf(mutation.error)).length === 0 && (
            <Alert color="red">{apiError(mutation.error)}</Alert>
          )}
          <TextInput
            label={t("auth.fields.username")}
            description={t("auth.fields.usernameHint")}
            autoComplete="username"
            autoCapitalize="none"
            size="md"
            {...form.getInputProps("username")}
          />
          <TextInput
            label={t("auth.fields.displayName")}
            autoComplete="name"
            size="md"
            {...form.getInputProps("displayName")}
          />
          <PasswordInput
            label={t("auth.fields.password")}
            description={t("validation.passwordTooShort", { min: 10 })}
            autoComplete="new-password"
            size="md"
            {...form.getInputProps("password")}
          />
          <PasswordInput
            label={t("auth.fields.confirmPassword")}
            autoComplete="new-password"
            size="md"
            {...form.getInputProps("confirm")}
          />
          <Select
            label={t("language.label")}
            data={LOCALES.map((l) => ({ value: l, label: t(`language.${l}`) }))}
            allowDeselect={false}
            size="md"
            {...form.getInputProps("locale")}
            onChange={(v) => {
              if (v) {
                form.setFieldValue("locale", v as Locale);
                void changeLanguage(v as Locale, i18n);
              }
            }}
          />
          <Button type="submit" size="md" loading={mutation.isPending} fullWidth>
            {t("auth.invite.submit")}
          </Button>
        </Stack>
      </form>
    </AuthLayout>
  );
}
