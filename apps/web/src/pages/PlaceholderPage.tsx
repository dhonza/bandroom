import { Center, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import type { Icon } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

export type PlaceholderKey = "recent" | "notifications";

/** Empty-state page used until each section is built in its milestone. */
export function PlaceholderPage({
  pageKey,
  icon: PageIcon,
}: {
  pageKey: PlaceholderKey;
  icon: Icon;
}) {
  const { t } = useTranslation();
  return (
    <Stack gap="lg">
      <Title order={2}>{t(`pages.${pageKey}.title`)}</Title>
      <Center mih={240}>
        <Stack align="center" gap="sm" maw={420}>
          <ThemeIcon size={64} radius="xl" variant="light">
            <PageIcon size={34} aria-hidden />
          </ThemeIcon>
          <Text ta="center" c="dimmed">
            {t(`pages.${pageKey}.empty`)}
          </Text>
        </Stack>
      </Center>
    </Stack>
  );
}
