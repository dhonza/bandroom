import { Badge, NavLink as MantineNavLink, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";
import { useCurrentUser } from "../auth/session";
import { useClientConfig } from "../config/ClientConfigContext";
import { DESKTOP_NAV, visibleFor } from "./navItems";
import { useUnreadCount } from "../notifications/queries";

export function DesktopNav() {
  const { t } = useTranslation();
  const { version } = useClientConfig();
  const user = useCurrentUser();
  const unread = useUnreadCount();
  return (
    <Stack
      component="nav"
      aria-label={t("nav.main")}
      data-testid="desktop-nav"
      justify="space-between"
      h="100%"
      gap="xs"
    >
      <Stack gap={4}>
        {visibleFor(DESKTOP_NAV, user).map((item) => (
          <MantineNavLink
            key={item.key}
            component={NavLink}
            to={item.path}
            label={t(`nav.${item.key}`)}
            leftSection={<item.icon size={20} aria-hidden />}
            rightSection={
              item.key === "notifications" && unread > 0 ? (
                <Badge size="sm" color="red" circle={unread < 10}>
                  {unread > 99 ? "99+" : unread}
                </Badge>
              ) : undefined
            }
            mih={44}
            style={{ borderRadius: "var(--mantine-radius-md)" }}
          />
        ))}
      </Stack>
      <Text size="xs" c="dimmed" px="sm">
        {t("footer.version", { version })}
      </Text>
    </Stack>
  );
}
