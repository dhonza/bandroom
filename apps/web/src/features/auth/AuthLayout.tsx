import { Box, Center, Group, Paper, Stack, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";
import { BrandLogo } from "../../branding/BrandLogo";
import { useClientConfig } from "../../config/ClientConfigContext";
import { ColorSchemeToggle } from "../../shell/ColorSchemeToggle";
import { LanguageSwitcher } from "../../shell/LanguageSwitcher";

/** Centered card used by login, invite and reset pages (no app navigation). */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  const { appName } = useClientConfig();
  return (
    <Box mih="100dvh" style={{ display: "flex", flexDirection: "column" }}>
      <Group
        justify="space-between"
        px="md"
        h={56}
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <BrandLogo alt="" />
          <Text fw={700} size="lg" truncate>
            {appName}
          </Text>
        </Group>
        <Group gap={4}>
          <LanguageSwitcher />
          <ColorSchemeToggle />
        </Group>
      </Group>
      <Center style={{ flex: 1 }} px="md" pb="xl">
        <Paper withBorder radius="lg" p={{ base: "lg", sm: "xl" }} w="100%" maw={420}>
          <Stack gap="lg">
            <Stack gap={4}>
              <Title order={2}>{title}</Title>
              {subtitle && (
                <Text c="dimmed" size="sm">
                  {subtitle}
                </Text>
              )}
            </Stack>
            {children}
          </Stack>
        </Paper>
      </Center>
    </Box>
  );
}
