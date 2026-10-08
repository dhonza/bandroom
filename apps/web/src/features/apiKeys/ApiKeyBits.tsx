import type { ApiKeyInfo, ApiScope } from "@bandroom/shared";
import { Badge, Group, Text } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useFormatters } from "../../i18n/format";

/** i18n keys per scope (":" would be read as an i18next namespace separator). */
export const SCOPE_LABEL = {
  read: "apiKeys.scope.read",
  write: "apiKeys.scope.write",
  "admin:read": "apiKeys.scope.admin_read",
  "admin:ops": "apiKeys.scope.admin_ops",
} as const satisfies Record<ApiScope, string>;

const SCOPE_COLORS: Record<ApiScope, string> = {
  read: "teal",
  write: "blue",
  "admin:read": "orange",
  "admin:ops": "red",
};

export function ScopeBadges({ scopes }: { scopes: readonly ApiScope[] }) {
  const { t } = useTranslation();
  return (
    <Group gap={4}>
      {scopes.map((s) => (
        <Badge key={s} size="xs" variant="light" color={SCOPE_COLORS[s]}>
          {t(SCOPE_LABEL[s])}
        </Badge>
      ))}
    </Group>
  );
}

/** "brk_AbCdEf… · used 2 hours ago · expires 1 Jan 2027" (visible text, no hover-only info). */
export function KeyMeta({ k }: { k: ApiKeyInfo }) {
  const { t } = useTranslation();
  // Rendering time, fixed per mount (expiry is a day-scale property).
  const [now] = useState(() => Date.now());
  const fmt = useFormatters();
  const used =
    k.lastUsedAt === null
      ? t("apiKeys.neverUsed")
      : t("apiKeys.lastUsed", { when: fmt.relative(k.lastUsedAt) });
  const expiry =
    k.expiresAt === null
      ? t("apiKeys.neverExpires")
      : k.expiresAt <= now
        ? t("apiKeys.expired")
        : t("apiKeys.expires", { when: fmt.dateTime(k.expiresAt) });
  return (
    <Text size="xs" c={k.expiresAt !== null && k.expiresAt <= now ? "red" : "dimmed"}>
      <Text span ff="monospace" size="xs">
        {k.prefix}…
      </Text>
      {` · ${used} · ${expiry}`}
    </Text>
  );
}
