import { completePasswordReset, getPasswordReset, PasswordSchema } from "@bandroom/shared";
import { Alert, Button, Loader, PasswordInput, Stack } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../../api/client";
import { fieldErrorsOf, translateValidation, useApiError } from "../../api/useApiError";
import { zodValidator } from "../../api/validate";
import { useSetSessionUser } from "../../auth/session";
import { AuthLayout } from "./AuthLayout";

export function ResetPasswordPage() {
  const { t } = useTranslation();
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const setUser = useSetSessionUser();
  const apiError = useApiError();

  const reset = useQuery({
    queryKey: ["password-reset", token],
    queryFn: ({ signal }) => api(getPasswordReset, { params: { token } }, { signal }),
    retry: false,
  });

  const form = useForm({
    initialValues: { password: "", confirm: "" },
    validate: {
      password: zodValidator(PasswordSchema, t),
      confirm: (v, values) =>
        v === values.password ? null : translateValidation(t, "PASSWORDS_DIFFER"),
    },
  });

  const mutation = useMutation({
    mutationFn: (values: typeof form.values) =>
      api(completePasswordReset, { params: { token }, body: { password: values.password } }),
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

  if (reset.isPending) {
    return (
      <AuthLayout title={t("auth.reset.title")}>
        <Loader mx="auto" />
      </AuthLayout>
    );
  }
  if (reset.isError) {
    return (
      <AuthLayout title={t("auth.reset.title")}>
        <Alert color="red" data-testid="reset-invalid">
          {apiError(reset.error)}
        </Alert>
        <Button component={Link} to="/login" variant="default">
          {t("auth.login.title")}
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t("auth.reset.title")}
      subtitle={t("auth.reset.subtitle", { username: reset.data.username })}
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
          <PasswordInput
            label={t("auth.fields.newPassword")}
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
          <Button type="submit" size="md" loading={mutation.isPending} fullWidth>
            {t("auth.reset.submit")}
          </Button>
        </Stack>
      </form>
    </AuthLayout>
  );
}
