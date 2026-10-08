import { INSTRUMENTS, InstrumentSchema, guessInstrument } from "@bandroom/shared";
import { Button, Group, Select, Switch, Text, TextInput } from "@mantine/core";
import { useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../auth/session";
import { useUpdateMe } from "../../auth/useAccount";
import { Section } from "../../components/Section";
import { setPrefs, useRehearse } from "../../rehearse/controller";

/** Select value for "automatic" (null in the API). */
const AUTO = "auto";

/**
 * Audio settings (SPEC §11.2): "my instrument" (account) plus quality, lossless preference and
 * keep-screen-on for this device.
 */
export function AudioSection() {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const update = useUpdateMe();
  const prefs = useRehearse((s) => s.prefs);
  const form = useForm({
    initialValues: { instrument: user.instrument ?? AUTO, instrumentTag: user.instrumentTag },
  });
  const guess = guessInstrument(form.values.instrumentTag);

  return (
    <Section title={t("settings.audio.title")} testId="settings-audio">
      <form
        onSubmit={form.onSubmit((v) => {
          update.mutate(
            {
              instrument: InstrumentSchema.safeParse(v.instrument).data ?? null,
              instrumentTag: v.instrumentTag.trim(),
            },
            {
              onSuccess: () => {
                form.resetDirty();
                notifications.show({ color: "teal", message: t("settings.saved") });
              },
            },
          );
        })}
      >
        <Select
          label={t("settings.audio.instrument")}
          description={t("settings.audio.instrumentHint")}
          data-testid="settings-instrument"
          allowDeselect={false}
          data={[
            {
              value: AUTO,
              label: guess
                ? t("instruments.automaticGuess", { guess: t(`instruments.${guess}`) })
                : t("instruments.automatic"),
            },
            ...INSTRUMENTS.map((i) => ({ value: i, label: t(`instruments.${i}`) })),
          ]}
          {...form.getInputProps("instrument")}
        />
        <TextInput
          label={t("settings.audio.instrumentTag")}
          description={t("settings.audio.instrumentTagHint")}
          maxLength={40}
          mt="sm"
          {...form.getInputProps("instrumentTag")}
        />
        <Group justify="flex-end" mt="sm">
          <Button type="submit" loading={update.isPending} disabled={!form.isDirty()}>
            {t("common.save")}
          </Button>
        </Group>
      </form>
      <Text fw={600} size="sm" mt="md">
        {t("settings.audio.deviceTitle")}
      </Text>
      <Select
        label={t("rehearse.quality.title")}
        value={prefs.quality}
        allowDeselect={false}
        onChange={(v) => {
          if (v) setPrefs({ quality: v });
        }}
        data={(["auto", "lossless", "high", "low"] as const).map((q) => ({
          value: q,
          label: t(`rehearse.quality.${q}`),
        }))}
      />
      <Switch
        checked={prefs.preferLossless}
        onChange={(e) => {
          setPrefs({ preferLossless: e.currentTarget.checked });
        }}
        label={t("rehearse.quality.preferLossless")}
      />
      <Select
        label={t("rehearse.wakeLock.title")}
        value={prefs.wakeLock}
        allowDeselect={false}
        onChange={(v) => {
          if (v === "off" || v === "playing" || v === "songOpen") setPrefs({ wakeLock: v });
        }}
        data={(["off", "playing", "songOpen"] as const).map((w) => ({
          value: w,
          label: t(`rehearse.wakeLock.${w}`),
        }))}
      />
    </Section>
  );
}
