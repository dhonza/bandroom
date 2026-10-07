import { Group, Indicator, Text, UnstyledButton, VisuallyHidden } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";
import classes from "./BottomTabBar.module.css";
import { PHONE_TABS } from "./navItems";
import { useUnreadCount } from "../notifications/queries";

export const TAB_BAR_HEIGHT = 64;

/** Phone bottom tab bar; each tab is a ≥ 44 px touch target (SPEC §11.1). */
export function BottomTabBar() {
  const { t } = useTranslation();
  const unread = useUnreadCount();
  return (
    <Group
      component="nav"
      aria-label={t("nav.main")}
      data-testid="bottom-tab-bar"
      grow
      gap={0}
      h={TAB_BAR_HEIGHT}
      wrap="nowrap"
    >
      {PHONE_TABS.map((item) => (
        <UnstyledButton
          key={item.key}
          component={NavLink}
          to={item.path}
          className={classes.tab}
          h={TAB_BAR_HEIGHT}
        >
          <Indicator
            disabled={item.key !== "me" || unread === 0}
            size={10}
            offset={2}
            color="red"
            data-testid={item.key === "me" ? "me-tab-badge" : undefined}
          >
            <item.icon size={24} aria-hidden />
          </Indicator>
          <Text size="xs" fw={500} inherit>
            {t(`nav.${item.key}`)}
          </Text>
          {item.key === "me" && unread > 0 && (
            <VisuallyHidden>{t("notifications.unreadLabel", { count: unread })}</VisuallyHidden>
          )}
        </UnstyledButton>
      ))}
    </Group>
  );
}
