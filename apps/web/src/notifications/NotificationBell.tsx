import { ActionIcon, Indicator, Tooltip } from "@mantine/core";
import { IconBell } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useUnreadCount } from "./queries";

/** Bell with the unread badge in the app header (SPEC §16). */
export function NotificationBell() {
  const { t } = useTranslation();
  const count = useUnreadCount();
  const label =
    count > 0 ? t("notifications.unreadLabel", { count }) : t("pages.notifications.title");
  return (
    <Tooltip label={label}>
      <Indicator
        disabled={count === 0}
        label={count > 99 ? "99+" : count}
        size={18}
        offset={6}
        color="red"
        data-testid="notification-badge"
        data-count={count}
      >
        <ActionIcon
          component={Link}
          to="/notifications"
          size={44}
          variant="subtle"
          color="gray"
          aria-label={label}
          data-testid="notification-bell"
        >
          <IconBell size={22} />
        </ActionIcon>
      </Indicator>
    </Tooltip>
  );
}
