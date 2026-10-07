import { LOCALES, THEMES } from "@bandroom/shared";
import { SegmentedControl, Select, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../auth/session";
import { useUpdateMe } from "../../auth/useAccount";
import { Section } from "../../components/Section";
import { changeLanguage } from "../../i18n/i18n";

const AUTO = "auto";

export function AppearanceSection() {
  const { t, i18n } = useTranslation();
  const user = useCurrentUser();
  const update = useUpdateMe();

  return (
    <Section title={t("settings.appearance.title")} testId="settings-appearance">
      <Select
        label={t("language.label")}
        data-testid="settings-language"
        allowDeselect={false}
        value={user.locale ?? AUTO}
        data={[
          { value: AUTO, label: t("settings.appearance.languageAuto") },
          ...LOCALES.map((l) => ({ value: l, label: t(`language.${l}`) })),
        ]}
        onChange={(v) => {
          const locale = v === AUTO || v === null ? null : v;
          update.mutate({ locale });
          if (locale) void changeLanguage(locale, i18n);
        }}
      />
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          {t("settings.appearance.theme")}
        </Text>
        <SegmentedControl
          data-testid="settings-theme"
          value={user.theme}
          data={THEMES.map((th) => ({ value: th, label: t(`appearance.${th}`) }))}
          onChange={(v) => {
            update.mutate({ theme: v });
          }}
        />
      </Stack>
    </Section>
  );
}
