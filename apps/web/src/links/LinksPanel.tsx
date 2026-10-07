import type { PublicLink } from "@bandroom/shared";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  CopyButton,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconChartBar,
  IconCheck,
  IconCopy,
  IconDotsVertical,
  IconExternalLink,
  IconLink,
  IconLock,
  IconPencil,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApiError } from "../api/useApiError";
import { useFormatters } from "../i18n/format";
import { LinkAnalyticsModal } from "./LinkAnalyticsModal";
import { LinkFormModal } from "./LinkFormModal";
import { linkSummaryKeys, statParts } from "./model";
import { useLinkMutations, useLinks, type LinkOwner } from "./queries";
import { errorMessage } from "../api/errorMessage";

const STATUS_COLOR: Record<PublicLink["status"], string> = {
  active: "teal",
  inactive: "gray",
  expired: "orange",
  revoked: "red",
};

/**
 * Public links of a project, a song, or the whole instance (admins), with create, copy, edit,
 * deactivate, revoke and analytics (SPEC §3.5, §14.3).
 */
export function LinksPanel({
  owner,
  canCreate,
  showWhere = false,
  autoCreate = false,
}: {
  owner: LinkOwner;
  canCreate: boolean;
  /** Show the project/song of each link (project and admin lists). */
  showWhere?: boolean;
  /** Open the create dialog right away (the header's Share button). */
  autoCreate?: boolean;
}) {
  const { t } = useTranslation();
  const q = useLinks(owner);
  const [creating, setCreating] = useState(autoCreate);
  const [created, setCreated] = useState<PublicLink | null>(null);
  const links = q.data?.links ?? [];
  const live = links.filter((l) => l.status !== "revoked");
  const revoked = links.filter((l) => l.status === "revoked");

  return (
    <Stack gap="sm" data-testid="links-panel">
      {canCreate && (
        <Group>
          <Button
            h={44}
            leftSection={<IconPlus size={16} />}
            onClick={() => {
              setCreating(true);
            }}
            data-testid="link-create"
          >
            {t("links.create")}
          </Button>
        </Group>
      )}
      {q.isPending && <Loader size="sm" />}
      {q.isError && <Alert color="red">{errorMessage(t, q.error)}</Alert>}
      {q.isSuccess && links.length === 0 && (
        <Text size="sm" c="dimmed">
          {t("links.empty")}
        </Text>
      )}
      {live.map((l) => (
        <LinkCard key={l.id} link={l} showWhere={showWhere} />
      ))}
      {revoked.length > 0 && (
        <Text size="xs" c="dimmed" mt="xs">
          {t("links.revokedHeading", { count: revoked.length })}
        </Text>
      )}
      {revoked.map((l) => (
        <LinkCard key={l.id} link={l} showWhere={showWhere} />
      ))}
      {creating && (
        <LinkFormModal
          mode="create"
          owner={owner}
          onClose={() => {
            setCreating(false);
          }}
          onCreated={setCreated}
        />
      )}
      <LinkCreatedModal
        link={created}
        onClose={() => {
          setCreated(null);
        }}
      />
    </Stack>
  );
}

function LinkCard({ link, showWhere }: { link: PublicLink; showWhere: boolean }) {
  const { t } = useTranslation();
  const fmt = useFormatters();
  const apiError = useApiError();
  const { update, revoke } = useLinkMutations();
  const [editing, setEditing] = useState(false);
  const [stats, setStats] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const revoked = link.status === "revoked";
  const onError = (err: unknown) => notifications.show({ color: "red", message: apiError(err) });
  const where = [link.projectName, link.songTitle].filter(Boolean).join(" · ");

  return (
    <Paper withBorder radius="md" p="sm" data-testid="link-card" data-link-id={link.id}>
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Group gap={6} wrap="wrap">
              <IconLink size={16} />
              <Text fw={600} style={{ overflowWrap: "anywhere" }} data-testid="link-card-label">
                {link.label || t("links.untitled")}
              </Text>
              <Badge size="sm" variant="light" color={STATUS_COLOR[link.status]}>
                {t(`links.status.${link.status}`)}
              </Badge>
              {link.hasPassword && (
                <Badge size="sm" variant="light" color="gray" leftSection={<IconLock size={10} />}>
                  {t("links.badges.password")}
                </Badge>
              )}
            </Group>
            {showWhere && (
              <Text size="xs" c="dimmed">
                {where}
              </Text>
            )}
            <Text size="sm" c="dimmed">
              {linkSummaryKeys(link)
                .map((k) =>
                  k === "links.scope.versions"
                    ? t("links.versionCount", { count: link.versionIds.length })
                    : t(k as "links.scope.song"),
                )
                .join(" · ")}
            </Text>
            <Text size="xs" c="dimmed">
              {[
                link.allowDownload &&
                  (link.downloadPolicyAllows
                    ? t("links.badges.downloads")
                    : t("links.badges.downloadsBlocked")),
                link.allowComments && t("links.badges.comments"),
                link.showComments && t("links.badges.bandComments"),
                link.expiresAt !== null &&
                  t(link.status === "expired" ? "links.expired" : "links.expires", {
                    when: fmt.dateTime(link.expiresAt),
                  }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            <Text size="xs" c="dimmed" data-testid="link-card-stats">
              {statParts(link.stats)
                .map((p) => t(`links.stats.${p.key as "opens"}`, { count: p.count }))
                .join(" · ")}
              {link.stats.lastAccessAt !== null &&
                ` · ${t("links.lastAccess", { when: fmt.relative(link.stats.lastAccessAt) })}`}
            </Text>
          </Stack>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon
                size={44}
                variant="subtle"
                color="gray"
                aria-label={t("links.actions")}
                data-testid="link-menu"
              >
                <IconDotsVertical size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconChartBar size={16} />}
                onClick={() => {
                  setStats(true);
                }}
                data-testid="link-analytics"
              >
                {t("links.analytics.open")}
              </Menu.Item>
              {!revoked && (
                <>
                  <Menu.Item
                    leftSection={<IconPencil size={16} />}
                    onClick={() => {
                      setEditing(true);
                    }}
                    data-testid="link-edit"
                  >
                    {t("links.edit")}
                  </Menu.Item>
                  <Menu.Item
                    leftSection={
                      link.active ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />
                    }
                    onClick={() => {
                      update.mutate({ id: link.id, body: { active: !link.active } }, { onError });
                    }}
                    data-testid="link-toggle-active"
                  >
                    {link.active ? t("links.deactivate") : t("links.activate")}
                  </Menu.Item>
                  <Menu.Item
                    color="red"
                    leftSection={<IconTrash size={16} />}
                    onClick={() => {
                      setConfirmRevoke(true);
                    }}
                    data-testid="link-revoke"
                  >
                    {t("links.revoke")}
                  </Menu.Item>
                </>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>
        {!revoked && (
          <Group gap="xs" wrap="wrap">
            <CopyButton value={link.url}>
              {({ copied, copy }) => (
                <Button
                  size="sm"
                  h={44}
                  variant={copied ? "light" : "default"}
                  leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  onClick={copy}
                  data-testid="link-copy"
                >
                  {copied ? t("common.copied") : t("links.copy")}
                </Button>
              )}
            </CopyButton>
            <Anchor
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              size="sm"
              data-testid="link-url"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, minHeight: 44 }}
            >
              <IconExternalLink size={16} />
              {t("links.openLink")}
            </Anchor>
          </Group>
        )}
      </Stack>
      {editing && (
        <LinkFormModal
          mode="edit"
          link={link}
          onClose={() => {
            setEditing(false);
          }}
        />
      )}
      {stats && (
        <LinkAnalyticsModal
          link={link}
          onClose={() => {
            setStats(false);
          }}
        />
      )}
      <Modal
        opened={confirmRevoke}
        onClose={() => {
          setConfirmRevoke(false);
        }}
        title={t("links.revoke")}
        centered
      >
        <Stack>
          <Text size="sm">{t("links.revokeExplain")}</Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              h={44}
              onClick={() => {
                setConfirmRevoke(false);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              color="red"
              h={44}
              loading={revoke.isPending}
              onClick={() => {
                revoke.mutate(link, {
                  onError,
                  onSuccess: () => {
                    setConfirmRevoke(false);
                  },
                });
              }}
              data-testid="link-revoke-confirm"
            >
              {t("links.revoke")}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}

/** Right after creating: the URL to copy and share. */
function LinkCreatedModal({ link, onClose }: { link: PublicLink | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal opened={link !== null} onClose={onClose} title={t("links.created")} centered size="lg">
      {link && (
        <Stack>
          <Text size="sm">{t("links.createdExplain")}</Text>
          <TextInput
            readOnly
            value={link.url}
            data-testid="link-created-url"
            onFocus={(e) => {
              e.currentTarget.select();
            }}
          />
          <Group justify="flex-end">
            <CopyButton value={link.url}>
              {({ copied, copy }) => (
                <Button
                  h={44}
                  variant={copied ? "light" : "filled"}
                  leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  onClick={copy}
                >
                  {copied ? t("common.copied") : t("common.copy")}
                </Button>
              )}
            </CopyButton>
            <Button variant="default" h={44} onClick={onClose} data-testid="link-created-close">
              {t("common.close")}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
