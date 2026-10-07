import { login } from "@bandroom/shared";
import { Alert, Anchor, Button, PasswordInput, Stack, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useDisclosure } from "@mantine/hooks";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { safeNext } from "../../auth/safeNext";
import { useSetSessionUser } from "../../auth/session";
import { AuthLayout } from "./AuthLayout";
import { ForgotPasswordModal } from "./ForgotPasswordModal";

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const setUser = useSetSessionUser();
  const apiError = useApiError();
  const [forgotOpen, forgot] = useDisclosure(false);

  const form = useForm({
    initialValues: { login: "", password: "" },
    validate: {
      login: (v) => (v.trim() ? null : t("validation.required")),
      password: (v) => (v ? null : t("validation.required")),
    },
  });

  const mutation = useMutation({
    mutationFn: (values: typeof form.values) => api(login, { body: values }),
    onSuccess: ({ user }) => {
      setUser(user);
      void navigate(safeNext(params.get("next")), { replace: true });
    },
  });

  return (
    <AuthLayout title={t("auth.login.title")}>
      <form
        onSubmit={form.onSubmit((v) => {
          mutation.mutate(v);
        })}
        noValidate
      >
        <Stack>
          {mutation.isError && (
            <Alert color="red" data-testid="login-error">
              {apiError(mutation.error)}
            </Alert>
          )}
          <TextInput
            label={t("auth.fields.login")}
            autoComplete="username"
            autoCapitalize="none"
            autoFocus
            size="md"
            {...form.getInputProps("login")}
          />
          <PasswordInput
            label={t("auth.fields.password")}
            autoComplete="current-password"
            size="md"
            {...form.getInputProps("password")}
          />
          <Button type="submit" size="md" loading={mutation.isPending} fullWidth>
            {t("auth.login.submit")}
          </Button>
          <Anchor
            component="button"
            type="button"
            size="sm"
            onClick={forgot.open}
            ta="center"
            mih={44}
          >
            {t("auth.login.forgot")}
          </Anchor>
        </Stack>
      </form>
      <ForgotPasswordModal
        opened={forgotOpen}
        onClose={forgot.close}
        initialLogin={form.values.login}
      />
    </AuthLayout>
  );
}
