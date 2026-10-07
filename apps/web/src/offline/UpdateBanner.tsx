import { Alert, Button, Group, Text } from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { applyUpdate, usePwa } from "./pwa";

/**
 * "New version available — reload" (SPEC §13). Never reloads on its own, so playback and unsaved
 * edits are not interrupted; "Later" hides it until the next start.
 */
export function UpdateBanner() {
  const { t } = useTranslation();
  const waiting = usePwa((s) => s.waiting);
  const [hidden, setHidden] = useState(false);
  if (!waiting || hidden) return null;
  return (
    <Alert
      color="brand"
      variant="light"
      mb="md"
      icon={<IconRefresh size={18} />}
      data-testid="update-banner"
    >
      <Group justify="space-between" gap="xs">
        <Text size="sm">{t("offline.update.title")}</Text>
        <Group gap="xs">
          <Button
            variant="subtle"
            size="sm"
            mih={44}
            onClick={() => {
              setHidden(true);
            }}
          >
            {t("offline.update.later")}
          </Button>
          <Button size="sm" mih={44} onClick={applyUpdate} data-testid="update-reload">
            {t("offline.update.reload")}
          </Button>
        </Group>
      </Group>
    </Alert>
  );
}
