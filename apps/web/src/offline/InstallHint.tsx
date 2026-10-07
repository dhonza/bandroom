import { Alert, Button, Group, List, Text } from "@mantine/core";
import { IconDeviceMobileDown, IconSquareArrowUp } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { isIos, isStandalone, promptInstall, usePwa } from "./pwa";

/**
 * Install prompt / instructions (SPEC §11.2, §13). iOS may delete the storage of web apps that are
 * not on the Home Screen, so it gets step-by-step "Add to Home Screen" instructions; Chromium
 * browsers get their own install prompt.
 */
export function InstallHint({ always = false }: { always?: boolean }) {
  const { t } = useTranslation();
  const prompt = usePwa((s) => s.installPrompt);
  if (isStandalone()) {
    return always ? (
      <Text size="sm" c="dimmed" data-testid="install-installed">
        {t("offline.install.installed")}
      </Text>
    ) : null;
  }
  if (isIos()) {
    return (
      <Alert
        color="yellow"
        variant="light"
        icon={<IconDeviceMobileDown size={18} />}
        title={t("offline.install.iosTitle")}
        data-testid="install-ios"
      >
        <Text size="sm" mb="xs">
          {t("offline.install.iosWhy")}
        </Text>
        <List type="ordered" size="sm" spacing={4}>
          <List.Item>
            <Group gap={4} wrap="nowrap" component="span">
              {t("offline.install.iosStep1")}
              <IconSquareArrowUp size={16} aria-hidden />
            </Group>
          </List.Item>
          <List.Item>{t("offline.install.iosStep2")}</List.Item>
          <List.Item>{t("offline.install.iosStep3")}</List.Item>
        </List>
      </Alert>
    );
  }
  if (prompt) {
    return (
      <Group justify="space-between" gap="xs" data-testid="install-prompt">
        <Text size="sm">{t("offline.install.explain")}</Text>
        <Button
          h={44}
          leftSection={<IconDeviceMobileDown size={16} />}
          onClick={() => void promptInstall()}
        >
          {t("offline.install.button")}
        </Button>
      </Group>
    );
  }
  return always ? (
    <Text size="sm" c="dimmed" data-testid="install-browser">
      {t("offline.install.browserMenu")}
    </Text>
  ) : null;
}
