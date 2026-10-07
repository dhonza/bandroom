import {
  listMySessions,
  revokeMyOtherSessions,
  revokeMySession,
  type SessionInfo,
} from "@bandroom/shared";
import { Badge, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { IconDeviceDesktop, IconDeviceMobile } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { Section } from "../../components/Section";
import { useFormatters } from "../../i18n/format";

export const SESSIONS_QUERY_KEY = ["me", "sessions"] as const;

/** Rough, dependency-free device label from a user agent string. */
export function describeUserAgent(ua: string | null): { label: string; mobile: boolean } {
  if (!ua) return { label: "?", mobile: false };
  const mobile = /iPhone|iPad|Android|Mobile/i.test(ua);
  const os =
    /iPhone|iPad/.exec(ua)?.[0] ??
    (/Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "");
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return { label: [browser, os].filter(Boolean).join(" · ") || ua.slice(0, 40), mobile };
}

export function SessionsSection() {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: ({ signal }) => api(listMySessions, undefined, { signal }),
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
  const revoke = useMutation({
    mutationFn: (id: string) => api(revokeMySession, { params: { id } }),
    onSuccess: invalidate,
  });
  const revokeOthers = useMutation({
    mutationFn: () => api(revokeMyOtherSessions),
    onSuccess: invalidate,
  });

  const list: SessionInfo[] = sessions.data?.sessions ?? [];
  return (
    <Section
      title={t("settings.sessions.title")}
      description={t("settings.sessions.description")}
      testId="settings-sessions"
    >
      {sessions.isPending ? (
        <Loader size="sm" />
      ) : (
        <Stack gap="sm">
          {list.map((s) => {
            const device = describeUserAgent(s.userAgent);
            const Icon = device.mobile ? IconDeviceMobile : IconDeviceDesktop;
            return (
              <Group key={s.id} justify="space-between" wrap="nowrap" data-testid="session-row">
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                  <Icon size={22} aria-hidden />
                  <Stack gap={0} style={{ minWidth: 0 }}>
                    <Group gap={6}>
                      <Text size="sm" fw={500} truncate>
                        {device.label}
                      </Text>
                      {s.current && (
                        <Badge size="xs" variant="light">
                          {t("settings.sessions.current")}
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed" truncate>
                      {t("settings.sessions.lastActive", { when: fmt.relative(s.lastUsedAt) })}
                      {s.ip ? ` · ${s.ip}` : ""}
                    </Text>
                  </Stack>
                </Group>
                {!s.current && (
                  <Button
                    variant="subtle"
                    color="red"
                    size="compact-sm"
                    mih={44}
                    loading={revoke.isPending && revoke.variables === s.id}
                    onClick={() => {
                      revoke.mutate(s.id);
                    }}
                  >
                    {t("settings.sessions.revoke")}
                  </Button>
                )}
              </Group>
            );
          })}
          {list.length > 1 && (
            <Group justify="flex-end">
              <Button
                variant="light"
                color="red"
                loading={revokeOthers.isPending}
                onClick={() => {
                  revokeOthers.mutate();
                }}
              >
                {t("settings.sessions.revokeOthers")}
              </Button>
            </Group>
          )}
        </Stack>
      )}
    </Section>
  );
}
