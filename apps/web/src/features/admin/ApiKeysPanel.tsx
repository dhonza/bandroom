import { adminListApiKeys, adminRevokeApiKey } from "@bandroom/shared";
import { Alert, Badge, Button, Group, Loader, Paper, Stack, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { KeyMeta, ScopeBadges } from "../apiKeys/ApiKeyBits";
import { ROLE_COLORS } from "./roleOptions";

export const ADMIN_API_KEYS_KEY = ["admin", "apiKeys"] as const;

/** Admin → API keys (SPEC §29.4): every user's keys; any can be revoked. */
export function ApiKeysPanel() {
  const { t } = useTranslation();
  const apiError = useApiError();
  const queryClient = useQueryClient();
  const keys = useQuery({
    queryKey: ADMIN_API_KEYS_KEY,
    queryFn: ({ signal }) => api(adminListApiKeys, undefined, { signal }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(adminRevokeApiKey, { params: { id } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ADMIN_API_KEYS_KEY }),
  });

  if (keys.isPending) return <Loader />;
  if (keys.isError) return <Alert color="red">{apiError(keys.error)}</Alert>;
  return (
    <Stack maw={760}>
      <Text size="sm" c="dimmed">
        {t("admin.apiKeys.explain")}
      </Text>
      {revoke.isError && <Alert color="red">{apiError(revoke.error)}</Alert>}
      {keys.data.keys.length === 0 && <Text c="dimmed">{t("admin.apiKeys.empty")}</Text>}
      <Stack gap="xs">
        {keys.data.keys.map((k) => (
          <Paper key={k.id} withBorder radius="md" p="sm" data-testid="admin-api-key-row">
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={2} style={{ minWidth: 0 }}>
                <Group gap={6}>
                  <Text size="sm" fw={500} truncate>
                    {k.name}
                  </Text>
                  <ScopeBadges scopes={k.scopes} />
                </Group>
                <Group gap={6}>
                  <Text size="xs">{t("admin.apiKeys.owner", { name: k.displayName })}</Text>
                  <Badge size="xs" variant="light" color={ROLE_COLORS[k.globalRole]}>
                    {t(`roles.${k.globalRole}`)}
                  </Badge>
                </Group>
                <KeyMeta k={k} />
              </Stack>
              <Button
                variant="subtle"
                color="red"
                mih={44}
                aria-label={t("apiKeys.revokeNamed", { name: k.name })}
                loading={revoke.isPending && revoke.variables === k.id}
                onClick={() => {
                  revoke.mutate(k.id);
                }}
              >
                {t("apiKeys.revoke")}
              </Button>
            </Group>
          </Paper>
        ))}
      </Stack>
    </Stack>
  );
}
