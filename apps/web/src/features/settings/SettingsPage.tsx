import { Stack, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { AppearanceSection } from "./AppearanceSection";
import { AudioSection } from "./AudioSection";
import { KeyboardSection } from "./KeyboardSection";
import { PasswordSection } from "./PasswordSection";
import { ProfileSection } from "./ProfileSection";
import { SessionsSection } from "./SessionsSection";
import { StorageSection } from "./StorageSection";

/** User settings (SPEC §11.2). Latency calibration comes with recording (M12). */
export function SettingsPage() {
  const { t } = useTranslation();
  return (
    <Stack gap="lg" maw={720}>
      <Title order={2}>{t("pages.settings.title")}</Title>
      <ProfileSection />
      <AppearanceSection />
      <AudioSection />
      <KeyboardSection />
      <PasswordSection />
      <StorageSection />
      <SessionsSection />
    </Stack>
  );
}
