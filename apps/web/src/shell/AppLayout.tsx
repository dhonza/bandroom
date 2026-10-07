import { ActionIcon, AppShell, Group, Title, Tooltip, VisuallyHidden } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import type { NotificationType } from "@bandroom/shared";
import { IconLayoutSidebarLeftCollapse } from "@tabler/icons-react";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router";
import { BrandLogo, useLogoHash } from "../branding/BrandLogo";
import { useClientConfig } from "../config/ClientConfigContext";
import { useEventStream } from "../realtime/useEventStream";
import { dropDeletedFromQueue } from "../player/dropDeleted";
import type { GoneSongs } from "../player/listenEngine";
import { BottomTabBar, TAB_BAR_HEIGHT } from "./BottomTabBar";
import { ChromeRestoreButton } from "./ChromeRestoreButton";
import { isChromeToggleKey, isTypingTarget, toggleChrome, useChrome } from "./chrome";
import { ColorSchemeToggle } from "./ColorSchemeToggle";
import { DesktopNav } from "./DesktopNav";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { MINI_PLAYER_HEIGHT, MiniPlayer, useMiniPlayerVisible } from "./MiniPlayer";
import { PHONE_QUERY } from "./mediaQueries";
import { UserMenu } from "./UserMenu";
import { NotificationBell } from "../notifications/NotificationBell";
import { useDocsInset } from "../documents/DocsPanel";
import { LogoutPrompt } from "../offline/LogoutPrompt";
import { OfflineIndicator } from "../offline/OfflineIndicator";
import { ProcessingIndicator } from "../processing/ProcessingIndicator";
import { UpdateBanner } from "../offline/UpdateBanner";

export function AppLayout() {
  const { appName } = useClientConfig();
  const isPhone = useMediaQuery(PHONE_QUERY, false, { getInitialValueInEffect: false });
  const { t } = useTranslation();
  // On phones a logo replaces the name in the header (it usually carries the name).
  const logoOnly = useLogoHash() !== null && isPhone;
  const onNotification = useCallback(
    (type: NotificationType) => {
      notifications.show({
        id: `notification-${type}`,
        title: t("notifications.toastTitle"),
        message: t(`notifications.toast.${type}`),
        color: "blue",
        autoClose: 5000,
      });
    },
    [t],
  );
  const onGone = useCallback(
    (gone: GoneSongs) => {
      dropDeletedFromQueue(t, gone);
    },
    [t],
  );
  useEventStream(true, onNotification, onGone);
  const mini = useMiniPlayerVisible();
  // Split view: the documents panel sits beside the page on desktop (SPEC §11.3).
  const docsInset = useDocsInset();
  // "Hide navigation" (SPEC §25.2): header and navbar or tab bar make room for the page.
  const hidden = useChrome((s) => s.hidden);
  useChromeShortcut();
  const tabBar = isPhone && !hidden;
  const footerHeight = (tabBar ? TAB_BAR_HEIGHT : 0) + (mini ? MINI_PLAYER_HEIGHT : 0);

  return (
    <AppShell
      header={{ height: "calc(56px + env(safe-area-inset-top))", collapsed: hidden }}
      // Each layout renders only its own navigation, so the accessibility tree has one main nav.
      {...(!isPhone && {
        navbar: { width: 240, breakpoint: 0, collapsed: { desktop: hidden, mobile: hidden } },
      })}
      footer={{
        height: `calc(${footerHeight}px + env(safe-area-inset-bottom))`,
        collapsed: footerHeight === 0,
      }}
      padding="md"
    >
      <AppShell.Header
        px="md"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
        inert={hidden}
        data-testid="app-header"
      >
        <Group h={56} justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: "0 1 auto" }}>
            <BrandLogo alt={logoOnly ? appName : ""} />
            {logoOnly ? (
              <VisuallyHidden component="h1">{appName}</VisuallyHidden>
            ) : (
              <Title order={1} size="h4" lineClamp={1} style={{ minWidth: 0 }}>
                {appName}
              </Title>
            )}
          </Group>
          <Group gap={4} wrap="nowrap" style={{ flex: "none" }}>
            <OfflineIndicator />
            <ProcessingIndicator />
            <NotificationBell />
            <LanguageSwitcher />
            <ColorSchemeToggle />
            {!isPhone && (
              <Tooltip label={t("chrome.hide")}>
                <ActionIcon
                  size={44}
                  variant="subtle"
                  color="gray"
                  aria-label={t("chrome.hide")}
                  onClick={toggleChrome}
                  data-testid="chrome-hide"
                >
                  <IconLayoutSidebarLeftCollapse size={22} />
                </ActionIcon>
              </Tooltip>
            )}
            <UserMenu />
          </Group>
        </Group>
      </AppShell.Header>

      {!isPhone && (
        <AppShell.Navbar p="sm" inert={hidden}>
          <DesktopNav />
        </AppShell.Navbar>
      )}

      <AppShell.Main
        style={{
          ...(docsInset > 0 && {
            paddingInlineEnd: `calc(var(--mantine-spacing-md) + ${String(docsInset)}px)`,
          }),
          ...(hidden && {
            paddingTop: "calc(var(--mantine-spacing-md) + env(safe-area-inset-top))",
          }),
        }}
      >
        {hidden && <ChromeRestoreButton />}
        <UpdateBanner />
        <Outlet />
        <LogoutPrompt />
      </AppShell.Main>

      {footerHeight > 0 && (
        <AppShell.Footer style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          {mini && <MiniPlayer />}
          {tabBar && <BottomTabBar />}
        </AppShell.Footer>
      )}
    </AppShell>
  );
}

/** `Shift+F` on every screen, except while typing or in a dialog. */
function useChromeShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || !isChromeToggleKey(e) || isTypingTarget(e.target))
        return;
      e.preventDefault();
      toggleChrome();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
