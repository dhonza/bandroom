import { Avatar, Menu, Text, UnstyledButton } from "@mantine/core";
import { IconLayoutSidebarLeftCollapse, IconLogout, IconSettings } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useCurrentUser } from "../auth/session";
import { useRequestLogout } from "../offline/LogoutPrompt";
import { setChromeHidden } from "./chrome";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [name.trim()];
  return letters
    .map((p) => p?.[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function UserMenu() {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const logout = useRequestLogout();

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <UnstyledButton
          aria-label={t("account.menu")}
          data-testid="user-menu"
          style={{ minWidth: 44, minHeight: 44, display: "grid", placeItems: "center" }}
        >
          <Avatar radius="xl" size={32} color="brand">
            {initials(user.displayName)}
          </Avatar>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          <Text size="sm" fw={600} c="bright">
            {user.displayName}
          </Text>
          <Text size="xs" c="dimmed">
            @{user.username}
          </Text>
        </Menu.Label>
        <Menu.Item component={Link} to="/settings" leftSection={<IconSettings size={16} />}>
          {t("nav.settings")}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconLayoutSidebarLeftCollapse size={16} />}
          rightSection={
            <Text size="xs" c="dimmed">
              Shift+F
            </Text>
          }
          data-testid="chrome-hide-menu"
          onClick={() => {
            setChromeHidden(true);
          }}
        >
          {t("chrome.hide")}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconLogout size={16} />}
          data-testid="logout"
          onClick={() => {
            logout.request();
          }}
        >
          {t("account.logout")}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
