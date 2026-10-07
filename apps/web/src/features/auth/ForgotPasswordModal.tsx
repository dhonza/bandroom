import { requestPasswordReset } from "@bandroom/shared";
import { Alert, Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";

/**
 * "Forgot password?" without email: records a request that admins see in user management
 * (decision log). The answer is the same whether or not the account exists.
 */
export function ForgotPasswordModal({
  opened,
  onClose,
  initialLogin,
}: {
  opened: boolean;
  onClose: () => void;
  initialLogin: string;
}) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const [login, setLogin] = useState("");
  const mutation = useMutation({
    mutationFn: (value: string) => api(requestPasswordReset, { body: { login: value } }),
  });

  const close = () => {
    mutation.reset();
    onClose();
  };

  return (
    <Modal opened={opened} onClose={close} title={t("auth.forgot.title")} centered>
      {mutation.isSuccess ? (
        <Stack>
          <Alert color="teal" data-testid="forgot-done">
            {t("auth.forgot.done")}
          </Alert>
          <Group justify="flex-end">
            <Button onClick={close}>{t("common.close")}</Button>
          </Group>
        </Stack>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const value = (login || initialLogin).trim();
            if (value) mutation.mutate(value);
          }}
        >
          <Stack>
            <Text size="sm">{t("auth.forgot.explain")}</Text>
            {mutation.isError && <Alert color="red">{apiError(mutation.error)}</Alert>}
            <TextInput
              label={t("auth.fields.login")}
              autoCapitalize="none"
              defaultValue={initialLogin}
              onChange={(e) => {
                setLogin(e.currentTarget.value);
              }}
              data-autofocus
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={mutation.isPending}>
                {t("auth.forgot.submit")}
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}
