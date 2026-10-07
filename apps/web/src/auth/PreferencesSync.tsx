import type { CurrentUser } from "@bandroom/shared";
import { useMantineColorScheme } from "@mantine/core";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { changeLanguage } from "../i18n/i18n";

/**
 * Applies the user's stored language and theme (SPEC §12: user setting wins) whenever the session
 * user changes, e.g. right after login or when another device changed them.
 */
export function PreferencesSync({ user }: { user: CurrentUser }) {
  const { i18n } = useTranslation();
  const { setColorScheme } = useMantineColorScheme();

  useEffect(() => {
    if (user.locale !== null && user.locale !== i18n.resolvedLanguage) {
      void changeLanguage(user.locale, i18n);
    }
  }, [user.locale, i18n]);

  useEffect(() => {
    setColorScheme(user.theme === "system" ? "auto" : user.theme);
  }, [user.theme, setColorScheme]);

  return null;
}
