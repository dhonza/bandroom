import {
  adminCreateResetLink,
  adminDismissResetRequest,
  adminUpdateUser,
  type AdminUser,
} from "@bandroom/shared";
import {
  ActionIcon,
  Alert,
  Avatar,
  Badge,
  Button,
  Group,
  Loader,
  Menu,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconDots,
  IconKey,
  IconLock,
  IconLockOpen,
  IconPencil,
  IconUserPlus,
  IconX,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { useCurrentUser } from "../../auth/session";
import { useFormatters } from "../../i18n/format";
import { initials } from "../../shell/UserMenu";
import { InviteCreateModal } from "./InviteCreateModal";
import { LinkResultModal } from "./LinkResultModal";
import { useAdminUsers, useInvalidateAdmin } from "./queries";
import { ROLE_COLORS } from "./roleOptions";
import { UserFormModal } from "./UserFormModal";
import { errorMessage } from "../../api/errorMessage";

export function UsersPanel() {
  const { t } = useTranslation();
  const users = useAdminUsers();
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [resetLink, setResetLink] = useState<{ url: string; expiresAt: number } | null>(null);

  if (users.isPending) return <Loader />;
  if (users.isError) return <Alert color="red">{errorMessage(t, users.error)}</Alert>;

  const pending = users.data.users.filter((u) => u.resetRequestedAt !== null);

  return (
    <Stack>
      <Group justify="flex-end" gap="sm">
        <Button
          variant="default"
          leftSection={<IconUserPlus size={16} />}
          onClick={() => {
            setCreating(true);
          }}
        >
          {t("admin.users.create")}
        </Button>
        <Button
          leftSection={<IconKey size={16} />}
          onClick={() => {
            setInviting(true);
          }}
          data-testid="invite-button"
        >
          {t("admin.invites.create")}
        </Button>
      </Group>

      {pending.length > 0 && (
        <Alert
          color="yellow"
          title={t("admin.users.resetRequestsTitle")}
          data-testid="reset-requests"
        >
          {t("admin.users.resetRequests", { count: pending.length })}
        </Alert>
      )}

      <Stack gap="xs">
        {users.data.users.map((u) => (
          <UserRow
            key={u.id}
            user={u}
            onEdit={() => {
              setEditing(u);
            }}
            onResetLink={setResetLink}
          />
        ))}
      </Stack>

      {creating && (
        <UserFormModal
          opened
          user={null}
          onClose={() => {
            setCreating(false);
          }}
        />
      )}
      {editing && (
        <UserFormModal
          opened
          user={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
      <InviteCreateModal
        opened={inviting}
        onClose={() => {
          setInviting(false);
        }}
      />
      <LinkResultModal
        link={resetLink}
        title={t("admin.users.resetLinkTitle")}
        explain={t("admin.users.resetLinkExplain")}
        onClose={() => {
          setResetLink(null);
        }}
      />
    </Stack>
  );
}

function UserRow({
  user,
  onEdit,
  onResetLink,
}: {
  user: AdminUser;
  onEdit: () => void;
  onResetLink: (link: { url: string; expiresAt: number }) => void;
}) {
  const { t } = useTranslation();
  const me = useCurrentUser();
  const fmt = useFormatters();
  const apiError = useApiError();
  const invalidate = useInvalidateAdmin();
  const onError = (err: unknown) => notifications.show({ color: "red", message: apiError(err) });

  const toggleDisabled = useMutation({
    mutationFn: () =>
      api(adminUpdateUser, {
        params: { id: user.id },
        body: { disabled: user.disabledAt === null },
      }),
    onSuccess: invalidate,
    onError,
  });
  const resetLink = useMutation({
    mutationFn: () => api(adminCreateResetLink, { params: { id: user.id } }),
    onSuccess: (link) => {
      invalidate();
      onResetLink(link);
    },
    onError,
  });
  const dismiss = useMutation({
    mutationFn: () => api(adminDismissResetRequest, { params: { id: user.id } }),
    onSuccess: invalidate,
    onError,
  });

  const disabled = user.disabledAt !== null;
  return (
    <Paper withBorder radius="md" p="sm" data-testid="admin-user-row" data-username={user.username}>
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <Avatar radius="xl" color={disabled ? "gray" : "brand"}>
            {initials(user.displayName)}
          </Avatar>
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Group gap={6} wrap="wrap">
              <Text fw={600} size="sm" truncate td={disabled ? "line-through" : undefined}>
                {user.displayName}
              </Text>
              <Badge size="xs" variant="light" color={ROLE_COLORS[user.globalRole]}>
                {t(`roles.${user.globalRole}`)}
              </Badge>
              {disabled && (
                <Badge size="xs" color="gray">
                  {t("admin.users.disabled")}
                </Badge>
              )}
              {user.resetRequestedAt !== null && (
                <Badge size="xs" color="yellow" data-testid="reset-requested">
                  {t("admin.users.resetRequested")}
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed" truncate>
              @{user.username}
              {user.id === me.id ? ` · ${t("admin.users.you")}` : ""}
              {" · "}
              {user.lastSeenAt === null
                ? t("admin.users.neverSeen")
                : t("admin.users.lastSeen", { when: fmt.relative(user.lastSeenAt) })}
            </Text>
          </Stack>
        </Group>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              size={44}
              aria-label={t("common.actions")}
              data-testid="user-actions"
            >
              <IconDots size={20} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconPencil size={16} />} onClick={onEdit}>
              {t("admin.users.edit")}
            </Menu.Item>
            <Menu.Item
              leftSection={<IconKey size={16} />}
              data-testid="create-reset-link"
              onClick={() => {
                resetLink.mutate();
              }}
            >
              {t("admin.users.createResetLink")}
            </Menu.Item>
            {user.resetRequestedAt !== null && (
              <Menu.Item
                leftSection={<IconX size={16} />}
                onClick={() => {
                  dismiss.mutate();
                }}
              >
                {t("admin.users.dismissRequest")}
              </Menu.Item>
            )}
            <Menu.Divider />
            <Menu.Item
              color={disabled ? undefined : "red"}
              leftSection={disabled ? <IconLockOpen size={16} /> : <IconLock size={16} />}
              onClick={() => {
                toggleDisabled.mutate();
              }}
            >
              {disabled ? t("admin.users.enable") : t("admin.users.disable")}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
    </Paper>
  );
}
