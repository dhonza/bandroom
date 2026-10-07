import { GLOBAL_ROLES } from "@bandroom/shared";
import type { TFunction } from "i18next";

export function roleOptions(t: TFunction) {
  return GLOBAL_ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) }));
}

export const ROLE_COLORS = { admin: "red", member: "brand", guest: "gray" } as const;
