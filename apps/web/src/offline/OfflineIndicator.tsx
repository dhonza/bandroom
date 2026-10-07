import { ActionIcon, Tooltip } from "@mantine/core";
import { IconCloudOff } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useOnline } from "./online";

/** Shown in the app header while offline (SPEC §13); opens the Offline page. */
export function OfflineIndicator() {
  const { t } = useTranslation();
  const online = useOnline();
  if (online) return null;
  return (
    <Tooltip label={t("offline.indicatorHint")} multiline w={260}>
      <ActionIcon
        component={Link}
        to="/offline"
        size={44}
        variant="light"
        color="yellow"
        aria-label={t("offline.indicator")}
        data-testid="offline-indicator"
      >
        <IconCloudOff size={22} />
      </ActionIcon>
    </Tooltip>
  );
}
