import {
  adminCreateUser,
  adminUpdateUser,
  DisplayNameSchema,
  EmailSchema,
  PasswordSchema,
  UsernameSchema,
  type AdminUser,
} from "@bandroom/shared";
import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { fieldErrorsOf, translateValidation, useApiError } from "../../api/useApiError";
import { zodValidator } from "../../api/validate";
import { useInvalidateAdmin } from "./queries";
import { roleOptions } from "./roleOptions";

/** Create a user (with initial password) or edit an existing one (name, email, role). */
export function UserFormModal({
  opened,
  user,
  onClose,
}: {
  opened: boolean;
  user: AdminUser | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const invalidate = useInvalidateAdmin();
  const isEdit = user !== null;
  const emailValidator = zodValidator(EmailSchema, t, "EMAIL");

  const form = useForm({
    mode: "controlled",
    initialValues: {
      username: user?.username ?? "",
      displayName: user?.displayName ?? "",
      email: user?.email ?? "",
      globalRole: user?.globalRole ?? "member",
      password: "",
      quotaMode:
        user?.quotaBytes === -1 ? "unlimited" : user?.quotaBytes == null ? "default" : "custom",
      quotaGb:
        user?.quotaBytes != null && user.quotaBytes > 0
          ? Math.round((user.quotaBytes / 1024 ** 3) * 10) / 10
          : 5,
    },
    validate: {
      username: isEdit ? () => null : zodValidator(UsernameSchema, t),
      displayName: zodValidator(DisplayNameSchema, t),
      email: (v) => (v.trim() === "" ? null : emailValidator(v)),
      password: isEdit ? () => null : zodValidator(PasswordSchema, t),
    },
  });

  const mutation = useMutation({
    mutationFn: async (v: typeof form.values) => {
      const email = v.email.trim() === "" ? null : v.email;
      const quotaBytes =
        v.quotaMode === "default"
          ? null
          : v.quotaMode === "unlimited"
            ? -1
            : Math.round(v.quotaGb * 1024 ** 3);
      if (user) {
        return api(adminUpdateUser, {
          params: { id: user.id },
          body: { displayName: v.displayName, email, globalRole: v.globalRole, quotaBytes },
        });
      }
      return api(adminCreateUser, {
        body: {
          username: v.username,
          displayName: v.displayName,
          email,
          globalRole: v.globalRole,
          password: v.password,
          quotaBytes,
        },
      });
    },
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: (err) => {
      for (const [field, code] of Object.entries(fieldErrorsOf(err))) {
        form.setFieldError(field, translateValidation(t, code));
      }
    },
  });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={isEdit ? t("admin.users.edit") : t("admin.users.create")}
      centered
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
            disabled={isEdit}
            autoCapitalize="none"
            {...form.getInputProps("username")}
          />
          <TextInput label={t("auth.fields.displayName")} {...form.getInputProps("displayName")} />
          <TextInput
            label={t("auth.fields.emailOptional")}
            type="email"
            autoCapitalize="none"
            {...form.getInputProps("email")}
          />
          <Select
            label={t("admin.users.role")}
            data={roleOptions(t)}
            allowDeselect={false}
            {...form.getInputProps("globalRole")}
          />
          <Select
            label={t("admin.users.quota")}
            allowDeselect={false}
            data={[
              { value: "default", label: t("admin.users.quotaDefault") },
              { value: "custom", label: t("admin.users.quotaCustom") },
              { value: "unlimited", label: t("admin.users.quotaUnlimited") },
            ]}
            {...form.getInputProps("quotaMode")}
          />
          {form.values.quotaMode === "custom" && (
            <NumberInput
              label={t("admin.users.quotaGb")}
              min={0.1}
              step={1}
              decimalScale={1}
              {...form.getInputProps("quotaGb")}
            />
          )}
          {!isEdit && (
            <PasswordInput
              label={t("admin.users.initialPassword")}
              description={t("validation.passwordTooShort", { min: 10 })}
              autoComplete="new-password"
              {...form.getInputProps("password")}
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {isEdit ? t("common.save") : t("admin.users.create")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
