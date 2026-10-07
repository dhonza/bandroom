import type { Notification } from "@bandroom/shared";
import {
  Alert,
  Button,
  Center,
  Group,
  Indicator,
  Loader,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
  UnstyledButton,
} from "@mantine/core";
import {
  IconAt,
  IconBell,
  IconCornerDownRight,
  IconDatabase,
  IconFileText,
  IconKey,
  IconLink,
  IconLock,
  IconMessageCircle,
  IconMusic,
  IconShieldCheck,
  IconUpload,
  type Icon,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useFormatters } from "../i18n/format";
import { describeNotification } from "./describe";
import { useMarkRead, useNotificationList } from "./queries";
import { errorMessage } from "../api/errorMessage";

const ICONS: Record<Notification["type"], Icon> = {
  mention: IconAt,
  reply: IconCornerDownRight,
  comment_on_upload: IconMessageCircle,
  new_version: IconUpload,
  new_song: IconMusic,
  granted: IconShieldCheck,
  quota_warning: IconDatabase,
  reset_request: IconKey,
  new_document: IconFileText,
  link_password_failed: IconLock,
  link_comment: IconLink,
};

/** Notifications (SPEC §11.2, §16): list, mark read, deep links; in-app only. */
export function NotificationsPage() {
  const { t } = useTranslation();
  const q = useNotificationList();
  const markRead = useMarkRead();
  const list = q.data?.pages.flatMap((p) => p.notifications) ?? [];
  const unread = q.data?.pages[0]?.unreadCount ?? 0;
  return (
    <Stack gap="md" maw={720}>
      <Group justify="space-between" wrap="wrap">
        <Title order={2}>{t("pages.notifications.title")}</Title>
        {unread > 0 && (
          <Button
            variant="light"
            h={44}
            onClick={() => {
              markRead.mutate("all");
            }}
            data-testid="notifications-read-all"
          >
            {t("notifications.markAllRead")}
          </Button>
        )}
      </Group>
      {q.isPending ? (
        <Center mih={120}>
          <Loader />
        </Center>
      ) : q.isError ? (
        <Alert color="red">{errorMessage(t, q.error)}</Alert>
      ) : list.length === 0 ? (
        <Stack align="center" gap="xs" py="xl">
          <ThemeIcon size={48} radius="xl" variant="light">
            <IconBell size={26} />
          </ThemeIcon>
          <Text c="dimmed">{t("pages.notifications.empty")}</Text>
        </Stack>
      ) : (
        <Stack gap="xs" data-testid="notifications-list">
          {list.map((n) => (
            <NotificationRow
              key={n.id}
              n={n}
              onOpen={() => {
                if (n.readAt === null) markRead.mutate([n.id]);
              }}
            />
          ))}
          {q.hasNextPage && (
            <Button
              variant="default"
              h={44}
              loading={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {t("notifications.loadMore")}
            </Button>
          )}
        </Stack>
      )}
    </Stack>
  );
}

function NotificationRow({ n, onOpen }: { n: Notification; onOpen: () => void }) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const navigate = useNavigate();
  const v = describeNotification(n, t);
  const Icon = ICONS[n.type];
  const unread = n.readAt === null;
  return (
    <Paper
      withBorder
      radius="md"
      p={0}
      data-testid="notification"
      data-unread={unread || undefined}
    >
      <UnstyledButton
        w="100%"
        p="sm"
        mih={44}
        onClick={() => {
          onOpen();
          if (v.link) void navigate(v.link);
        }}
        aria-label={v.title}
      >
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <Indicator disabled={!unread} size={10} offset={4} color="blue">
            <ThemeIcon variant="light" radius="xl" size={36} color={unread ? "blue" : "gray"}>
              <Icon size={18} />
            </ThemeIcon>
          </Indicator>
          <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
            <Text size="sm" fw={unread ? 700 : 500} style={{ overflowWrap: "anywhere" }}>
              {v.title}
            </Text>
            {v.detail && (
              <Text size="sm" c="dimmed" lineClamp={2} style={{ overflowWrap: "anywhere" }}>
                {v.detail}
              </Text>
            )}
            <Text size="xs" c="dimmed" title={fmt.dateTime(n.createdAt)}>
              {fmt.relative(n.createdAt)}
            </Text>
          </Stack>
        </Group>
      </UnstyledButton>
    </Paper>
  );
}
