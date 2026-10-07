import { Alert, Stack, Tabs, Text, Title } from "@mantine/core";
import {
  IconAdjustments,
  IconFileImport,
  IconLink,
  IconMailForward,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import { LinksPanel } from "../../links/LinksPanel";
import { useTranslation } from "react-i18next";
import { useOnline } from "../../offline/online";
import { useSearchParams } from "react-router";
import { ImportPanel } from "./imports/ImportPanel";
import { InstanceSettingsPanel } from "./InstanceSettingsPanel";
import { InvitesPanel } from "./InvitesPanel";
import { UsersPanel } from "./UsersPanel";
import { TrashPanel } from "../../trash/TrashPanel";
import { useAdminTrash } from "../../trash/queries";

const TABS = ["invites", "links", "settings", "import", "trash"] as const;
type Tab = "users" | (typeof TABS)[number];
const isTab = (v: string | null): v is (typeof TABS)[number] =>
  TABS.includes(v as (typeof TABS)[number]);

/** Admin area (SPEC §11.2): users, invites, settings, Samply import; storage/jobs/audit later. */
export function AdminPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: Tab = isTab(requested) ? requested : "users";
  const online = useOnline();
  return (
    <Stack gap="lg">
      <Title order={2}>{t("pages.admin.title")}</Title>
      {!online && (
        <Alert color="yellow" data-testid="admin-offline">
          {t("offline.adminNeedsNetwork")}
        </Alert>
      )}
      <Tabs
        value={tab}
        onChange={(v) => {
          setParams(isTab(v) ? { tab: v } : {}, { replace: true });
        }}
        keepMounted={false}
      >
        <Tabs.List>
          <Tabs.Tab value="users" leftSection={<IconUsers size={16} />} mih={44}>
            {t("admin.users.tab")}
          </Tabs.Tab>
          <Tabs.Tab value="invites" leftSection={<IconMailForward size={16} />} mih={44}>
            {t("admin.invites.tab")}
          </Tabs.Tab>
          <Tabs.Tab
            value="links"
            leftSection={<IconLink size={16} />}
            mih={44}
            data-testid="admin-links-tab"
          >
            {t("links.tab")}
          </Tabs.Tab>
          <Tabs.Tab
            value="settings"
            leftSection={<IconAdjustments size={16} />}
            mih={44}
            data-testid="admin-settings-tab"
          >
            {t("admin.settings.tab")}
          </Tabs.Tab>
          <Tabs.Tab
            value="import"
            leftSection={<IconFileImport size={16} />}
            mih={44}
            data-testid="admin-import-tab"
          >
            {t("admin.import.tab")}
          </Tabs.Tab>
          <Tabs.Tab
            value="trash"
            leftSection={<IconTrash size={16} />}
            mih={44}
            data-testid="admin-trash-tab"
          >
            {t("trash.title")}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="users" pt="md">
          <UsersPanel />
        </Tabs.Panel>
        <Tabs.Panel value="invites" pt="md">
          <InvitesPanel />
        </Tabs.Panel>
        <Tabs.Panel value="links" pt="md">
          <Stack gap="sm" maw={760}>
            <Text size="sm" c="dimmed">
              {t("links.adminExplain")}
            </Text>
            <LinksPanel owner={{ kind: "admin" }} canCreate={false} showWhere />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="settings" pt="md">
          <InstanceSettingsPanel />
        </Tabs.Panel>
        <Tabs.Panel value="import" pt="md">
          <ImportPanel />
        </Tabs.Panel>
        <Tabs.Panel value="trash" pt="md">
          <AdminTrash />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

function AdminTrash() {
  const query = useAdminTrash();
  return <TrashPanel scope="admin" query={query} showProject />;
}
