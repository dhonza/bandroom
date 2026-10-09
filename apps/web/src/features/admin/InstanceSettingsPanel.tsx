import {
  adminGetSettings,
  adminUpdateSettings,
  CONTENT_ROLES,
  LOCALES,
  type InstanceSettings,
} from "@bandroom/shared";
import { Alert, Button, Group, Loader, NumberInput, Select, Stack, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { Section } from "../../components/Section";
import { errorMessage } from "../../api/errorMessage";
import { LogoSection, settingsKey } from "./LogoSection";

const NONE = "__none";

export function InstanceSettingsPanel() {
  const { t } = useTranslation();
  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => api(adminGetSettings, undefined, { signal }),
  });
  if (settings.isPending) return <Loader />;
  if (settings.isError) return <Alert color="red">{errorMessage(t, settings.error)}</Alert>;
  return (
    <Stack gap="lg" maw={640}>
      <LogoSection logo={settings.data.logo} />
      <SettingsForm initial={settings.data.settings} />
    </Stack>
  );
}

function SettingsForm({ initial }: { initial: InstanceSettings }) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const qc = useQueryClient();
  const form = useForm({
    initialValues: {
      instanceName: initial.instanceName ?? "",
      defaultLocale: initial.defaultLocale ?? NONE,
      defaultProjectRoleMember: initial.defaultProjectRoleMember,
      defaultProjectRoleGuest: initial.defaultProjectRoleGuest,
      trashRetentionDays: initial.trashRetentionDays as number | string,
      recordingMaxTakeMinutes: initial.recordingMaxTakeMinutes as number | string,
      recordingPeakTargetDb: initial.recordingPeakTargetDb as number | string,
    },
  });
  const save = useMutation({
    mutationFn: (v: typeof form.values) =>
      api(adminUpdateSettings, {
        body: {
          instanceName: v.instanceName.trim() || null,
          defaultLocale:
            v.defaultLocale === NONE
              ? null
              : (v.defaultLocale as InstanceSettings["defaultLocale"]),
          defaultProjectRoleMember: v.defaultProjectRoleMember,
          defaultProjectRoleGuest: v.defaultProjectRoleGuest,
          // An emptied field keeps the stored value.
          trashRetentionDays: Number(v.trashRetentionDays) || initial.trashRetentionDays,
          recordingMaxTakeMinutes:
            Number(v.recordingMaxTakeMinutes) || initial.recordingMaxTakeMinutes,
          // 0 dBFS is a valid target: only an emptied field keeps the stored value.
          recordingPeakTargetDb:
            v.recordingPeakTargetDb === ""
              ? initial.recordingPeakTargetDb
              : Number(v.recordingPeakTargetDb),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries();
      form.resetDirty();
      notifications.show({ color: "teal", message: t("settings.saved") });
    },
    onError: (err) => notifications.show({ color: "red", message: apiError(err) }),
  });
  const roleOptions = CONTENT_ROLES.map((r) => ({ value: r, label: t(`contentRoles.${r}`) }));

  return (
    <form
      onSubmit={form.onSubmit((v) => {
        save.mutate(v);
      })}
    >
      <Stack gap="lg" maw={640}>
        <Section title={t("admin.settings.instance")}>
          <TextInput
            label={t("admin.settings.instanceName")}
            description={t("admin.settings.instanceNameHint")}
            maxLength={80}
            {...form.getInputProps("instanceName")}
          />
          <Select
            label={t("admin.settings.defaultLocale")}
            allowDeselect={false}
            data={[
              { value: NONE, label: t("admin.settings.defaultLocaleEnv") },
              ...LOCALES.map((l) => ({ value: l, label: t(`language.${l}`) })),
            ]}
            {...form.getInputProps("defaultLocale")}
          />
        </Section>
        <Section
          title={t("admin.settings.defaultRoles")}
          description={t("admin.settings.defaultRolesExplain")}
        >
          <Select
            label={t("admin.settings.defaultRoleMember")}
            allowDeselect={false}
            data={roleOptions}
            data-testid="default-role-member"
            {...form.getInputProps("defaultProjectRoleMember")}
          />
          <Select
            label={t("admin.settings.defaultRoleGuest")}
            allowDeselect={false}
            data={roleOptions}
            {...form.getInputProps("defaultProjectRoleGuest")}
          />
        </Section>
        <Section title={t("trash.title")}>
          <NumberInput
            label={t("admin.settings.trashRetentionDays")}
            description={t("admin.settings.trashRetentionHint")}
            min={1}
            max={3650}
            allowDecimal={false}
            data-testid="trash-retention"
            {...form.getInputProps("trashRetentionDays")}
          />
        </Section>
        <Section title={t("admin.settings.recording")}>
          <NumberInput
            label={t("admin.settings.recordingMaxTakeMinutes")}
            description={t("admin.settings.recordingMaxTakeHint")}
            min={1}
            max={600}
            allowDecimal={false}
            data-testid="recording-max-take"
            {...form.getInputProps("recordingMaxTakeMinutes")}
          />
          <NumberInput
            label={t("admin.settings.recordingPeakTarget")}
            description={t("admin.settings.recordingPeakTargetHint")}
            min={-24}
            max={0}
            step={0.5}
            decimalScale={1}
            allowNegative
            suffix=" dBFS"
            data-testid="recording-peak-target"
            {...form.getInputProps("recordingPeakTargetDb")}
          />
        </Section>
        <Group justify="flex-end">
          <Button type="submit" disabled={!form.isDirty()} loading={save.isPending}>
            {t("common.save")}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
