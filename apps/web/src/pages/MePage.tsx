import { Badge, Button, Group, NavLink as MantineNavLink, Stack, Text, Title } from "@mantine/core";
import { IconLogout } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";
import { useCurrentUser } from "../auth/session";
import { useClientConfig } from "../config/ClientConfigContext";
import { useRequestLogout } from "../offline/LogoutPrompt";
import { ME_LINKS, visibleFor } from "../shell/navItems";
import { useUnreadCount } from "../notifications/queries";

/** Phone "Me" tab: links to the sections that live in the desktop navbar. */
export function MePage() {
  const { t } = useTranslation();
  const { version } = useClientConfig();
  const user = useCurrentUser();
  const logout = useRequestLogout();
  const unread = useUnreadCount();
  return (
    <Stack gap="lg">
      <Stack gap={2}>
        <Title order={2}>{user.displayName}</Title>
        <Text c="dimmed" size="sm">
          @{user.username}
        </Text>
      </Stack>
      <Stack gap={4}>
        {visibleFor(ME_LINKS, user).map((item) => (
          <MantineNavLink
            key={item.key}
            component={NavLink}
            to={item.path}
            label={t(`nav.${item.key}`)}
            leftSection={<item.icon size={22} aria-hidden />}
            rightSection={
              item.key === "notifications" && unread > 0 ? (
                <Badge size="sm" color="red">
                  {unread > 99 ? "99+" : unread}
                </Badge>
              ) : undefined
            }
            mih={48}
          />
        ))}
      </Stack>
      <Group>
        <Button
          variant="light"
          color="red"
          leftSection={<IconLogout size={18} />}
          mih={44}
          onClick={() => {
            logout.request();
          }}
        >
          {t("account.logout")}
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        {t("footer.version", { version })}
      </Text>
    </Stack>
  );
}
