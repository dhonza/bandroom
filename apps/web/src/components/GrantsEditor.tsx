import { CONTENT_ROLES, type ContentRole, type GrantRow } from "@bandroom/shared";
import { Alert, Avatar, Badge, Group, Loader, Paper, Select, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "react-i18next";
import { useApiError } from "../api/useApiError";
import { initials } from "../shell/UserMenu";

const INHERIT = "__inherit";

/**
 * Lists every active user with their role in a scope and lets managers set or clear an explicit
 * grant (SPEC §3.2 layers 2 and 3). Admins always have full access, so their row is read-only.
 */
export function GrantsEditor({
  rows,
  loading,
  error,
  inheritLabelKey,
  onSet,
  onRemove,
}: {
  rows: GrantRow[] | undefined;
  loading: boolean;
  error: unknown;
  /** i18n key for the "no explicit grant" option, e.g. project default vs. song inherits project. */
  inheritLabelKey: "grants.inheritDefault" | "grants.inheritProject";
  onSet: (userId: string, role: ContentRole) => Promise<unknown>;
  onRemove: (userId: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const apiError = useApiError();
  if (loading) return <Loader size="sm" />;
  if (error) return <Alert color="red">{apiError(error)}</Alert>;

  const change = (userId: string, value: string | null) => {
    const p =
      value === INHERIT || value === null ? onRemove(userId) : onSet(userId, value as ContentRole);
    p.catch((err: unknown) => notifications.show({ color: "red", message: apiError(err) }));
  };

  return (
    <Stack gap="xs" data-testid="grants-editor">
      {(rows ?? []).map((r) => {
        const isAdmin = r.globalRole === "admin";
        return (
          <Paper
            key={r.userId}
            withBorder
            radius="md"
            p="sm"
            data-testid="grant-row"
            data-username={r.username}
          >
            <Group justify="space-between" wrap="wrap" gap="sm">
              <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: "1 1 200px" }}>
                <Avatar radius="xl" color="brand">
                  {initials(r.displayName)}
                </Avatar>
                <Stack gap={0} style={{ minWidth: 0 }}>
                  <Text size="sm" fw={600} truncate>
                    {r.displayName}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    @{r.username} · {t(`roles.${r.globalRole}`)}
                  </Text>
                </Stack>
              </Group>
              {isAdmin ? (
                <Badge variant="light" color="red">
                  {t("grants.adminFullAccess")}
                </Badge>
              ) : (
                <Select
                  aria-label={t("grants.roleFor", { name: r.displayName })}
                  data-testid="grant-select"
                  w={230}
                  allowDeselect={false}
                  value={r.grant ?? INHERIT}
                  onChange={(v) => {
                    change(r.userId, v);
                  }}
                  data={[
                    {
                      value: INHERIT,
                      label: t(inheritLabelKey, { role: t(`contentRoles.${r.inherited}`) }),
                    },
                    ...CONTENT_ROLES.map((role) => ({
                      value: role,
                      label: t(`contentRoles.${role}`),
                    })),
                  ]}
                />
              )}
            </Group>
          </Paper>
        );
      })}
    </Stack>
  );
}
