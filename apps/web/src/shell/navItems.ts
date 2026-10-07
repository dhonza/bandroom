import {
  IconBell,
  IconBooks,
  IconClockHour4,
  IconCloudDown,
  IconSettings,
  IconShieldLock,
  IconUserCircle,
  type Icon,
} from "@tabler/icons-react";
import { hasGlobalCapability, type CurrentUser, type GlobalCapability } from "@bandroom/shared";

export type NavKey =
  "library" | "recent" | "offline" | "notifications" | "admin" | "settings" | "me";

export interface NavItem {
  key: NavKey;
  path: `/${string}`;
  icon: Icon;
  /** Shown only to users with this global capability. */
  requires?: GlobalCapability;
}

/** Desktop left navbar (SPEC §11.2). */
export const DESKTOP_NAV: readonly NavItem[] = [
  { key: "library", path: "/library", icon: IconBooks },
  { key: "recent", path: "/recent", icon: IconClockHour4 },
  { key: "offline", path: "/offline", icon: IconCloudDown },
  { key: "notifications", path: "/notifications", icon: IconBell },
  { key: "admin", path: "/admin", icon: IconShieldLock, requires: "admin.access" },
  { key: "settings", path: "/settings", icon: IconSettings },
];

/** Phone bottom tab bar (SPEC §11.2). */
export const PHONE_TABS: readonly NavItem[] = [
  { key: "library", path: "/library", icon: IconBooks },
  { key: "recent", path: "/recent", icon: IconClockHour4 },
  { key: "offline", path: "/offline", icon: IconCloudDown },
  { key: "me", path: "/me", icon: IconUserCircle },
];

/** Items reachable from the phone "Me" tab. */
export const ME_LINKS: readonly NavItem[] = [
  { key: "notifications", path: "/notifications", icon: IconBell },
  { key: "settings", path: "/settings", icon: IconSettings },
  { key: "admin", path: "/admin", icon: IconShieldLock, requires: "admin.access" },
];

export function visibleFor(items: readonly NavItem[], user: CurrentUser): NavItem[] {
  return items.filter(
    (i) =>
      i.requires === undefined || hasGlobalCapability({ ...user, disabledAt: null }, i.requires),
  );
}
