import { adminRevokeInvite, type InviteInfo } from "@bandroom/shared";
import { Alert, Badge, Button, Group, Loader, Paper, Stack, Text } from "@mantine/core";
import { IconKey } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useFormatters } from "../../i18n/format";
import { InviteCreateModal } from "./InviteCreateModal";
import { useAdminInvites, useInvalidateAdmin } from "./queries";
import { ROLE_COLORS } from "./roleOptions";
import { errorMessage } from "../../api/errorMessage";

type Status = "active" | "used" | "revoked" | "expired";

export function inviteStatus(i: InviteInfo, now: number = Date.now()): Status {
  if (i.usedAt !== null) return "used";
  if (i.revokedAt !== null) return "revoked";
  if (i.expiresAt <= now) return "expired";
  return "active";
}

const STATUS_COLORS: Record<Status, string> = {
  active: "teal",
  used: "brand",
  revoked: "gray",
  expired: "gray",
};

export function InvitesPanel() {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const invites = useAdminInvites();
  const invalidate = useInvalidateAdmin();
  const [creating, setCreating] = useState(false);
  const revoke = useMutation({
    mutationFn: (id: string) => api(adminRevokeInvite, { params: { id } }),
    onSuccess: invalidate,
  });

  if (invites.isPending) return <Loader />;
  if (invites.isError) return <Alert color="red">{errorMessage(t, invites.error)}</Alert>;

  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {t("admin.invites.explain")}
        </Text>
        <Button
          leftSection={<IconKey size={16} />}
          onClick={() => {
            setCreating(true);
          }}
        >
          {t("admin.invites.create")}
        </Button>
      </Group>
      {invites.data.invites.length === 0 && <Text c="dimmed">{t("admin.invites.empty")}</Text>}
      <Stack gap="xs">
        {invites.data.invites.map((i) => {
          const status = inviteStatus(i);
          return (
            <Paper key={i.id} withBorder radius="md" p="sm" data-testid="invite-row">
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Group gap={6}>
                    <Badge size="xs" variant="light" color={ROLE_COLORS[i.globalRole]}>
                      {t(`roles.${i.globalRole}`)}
                    </Badge>
                    <Badge size="xs" color={STATUS_COLORS[status]}>
                      {t(`admin.invites.status.${status}`)}
                    </Badge>
                    {i.note && (
                      <Text size="sm" truncate>
                        {i.note}
                      </Text>
                    )}
                  </Group>
                  <Text size="xs" c="dimmed">
                    {status === "used"
                      ? t("admin.invites.usedBy", { username: i.usedByUsername ?? "?" })
                      : t("admin.invites.expires", { when: fmt.dateTime(i.expiresAt) })}
                    {i.createdByDisplayName
                      ? ` · ${t("admin.invites.createdBy", { name: i.createdByDisplayName })}`
                      : ""}
                  </Text>
                </Stack>
                {status === "active" && (
                  <Button
                    variant="subtle"
                    color="red"
                    mih={44}
                    loading={revoke.isPending && revoke.variables === i.id}
                    onClick={() => {
                      revoke.mutate(i.id);
                    }}
                  >
                    {t("admin.invites.revoke")}
                  </Button>
                )}
              </Group>
            </Paper>
          );
        })}
      </Stack>
      <InviteCreateModal
        opened={creating}
        onClose={() => {
          setCreating(false);
        }}
      />
    </Stack>
  );
}
