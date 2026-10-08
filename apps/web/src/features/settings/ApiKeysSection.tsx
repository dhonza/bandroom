import {
  API_KEY_EXPIRY_DAYS,
  API_SCOPES,
  ADMIN_API_SCOPES,
  createMyApiKey,
  listMyApiKeys,
  revokeMyApiKey,
  type ApiKeyInfo,
  type ApiScope,
} from "@bandroom/shared";
import {
  Alert,
  Button,
  Checkbox,
  CopyButton,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconCheck, IconCopy, IconKey } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { useApiError } from "../../api/useApiError";
import { useCurrentUser } from "../../auth/session";
import { Section } from "../../components/Section";
import { KeyMeta, SCOPE_LABEL, ScopeBadges } from "../apiKeys/ApiKeyBits";

export const API_KEYS_QUERY_KEY = ["me", "apiKeys"] as const;

/** Settings → API keys (SPEC §29.4): list, create with a reveal-once token, revoke. */
export function ApiKeysSection() {
  const { t } = useTranslation();
  const apiError = useApiError();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const keys = useQuery({
    queryKey: API_KEYS_QUERY_KEY,
    queryFn: ({ signal }) => api(listMyApiKeys, undefined, { signal }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(revokeMyApiKey, { params: { id } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY }),
  });

  const list: ApiKeyInfo[] = keys.data?.keys ?? [];
  return (
    <Section
      title={t("settings.apiKeys.title")}
      description={t("settings.apiKeys.description")}
      testId="settings-api-keys"
    >
      {keys.isPending ? (
        <Loader size="sm" />
      ) : (
        <Stack gap="sm">
          {keys.isError && <Alert color="red">{apiError(keys.error)}</Alert>}
          {revoke.isError && <Alert color="red">{apiError(revoke.error)}</Alert>}
          {list.length === 0 && (
            <Text size="sm" c="dimmed">
              {t("settings.apiKeys.empty")}
            </Text>
          )}
          {list.map((k) => (
            <Group key={k.id} justify="space-between" wrap="nowrap" data-testid="api-key-row">
              <Stack gap={2} style={{ minWidth: 0 }}>
                <Group gap={6}>
                  <Text size="sm" fw={500} truncate>
                    {k.name}
                  </Text>
                  <ScopeBadges scopes={k.scopes} />
                </Group>
                <KeyMeta k={k} />
              </Stack>
              <Button
                variant="subtle"
                color="red"
                size="compact-sm"
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
          ))}
          <Group justify="flex-end">
            <Button
              variant="light"
              leftSection={<IconKey size={16} />}
              mih={44}
              data-testid="api-key-create"
              onClick={() => {
                setCreating(true);
              }}
            >
              {t("settings.apiKeys.create")}
            </Button>
          </Group>
        </Stack>
      )}
      <CreateApiKeyModal
        opened={creating}
        onClose={() => {
          setCreating(false);
        }}
      />
    </Section>
  );
}

const DEFAULT_EXPIRY = "365";

const SCOPE_HINT = {
  read: "apiKeys.scopeHint.read",
  write: "apiKeys.scopeHint.write",
  "admin:read": "apiKeys.scopeHint.admin_read",
  "admin:ops": "apiKeys.scopeHint.admin_ops",
} as const satisfies Record<ApiScope, string>;

function CreateApiKeyModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const queryClient = useQueryClient();
  const user = useCurrentUser();
  const isAdmin = user.globalRole === "admin";
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>(["read", "write"]);
  const [expiry, setExpiry] = useState<string>(DEFAULT_EXPIRY);
  const [token, setToken] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api(createMyApiKey, {
        body: {
          name: name.trim(),
          scopes,
          expiresInDays: expiry === "never" ? null : Number(expiry),
        },
      }),
    onSuccess: (res) => {
      setToken(res.token);
      void queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
    },
  });

  const close = () => {
    setName("");
    setScopes(["read", "write"]);
    setExpiry(DEFAULT_EXPIRY);
    setToken(null);
    create.reset();
    onClose();
  };

  const available = API_SCOPES.filter((s) => isAdmin || !ADMIN_API_SCOPES.includes(s));
  const expiryOptions = [
    ...API_KEY_EXPIRY_DAYS.map((d) => ({
      value: String(d),
      label: t("settings.apiKeys.expiryDays", { count: d }),
    })),
    { value: "never", label: t("settings.apiKeys.expiryNever") },
  ];

  return (
    <Modal
      opened={opened}
      onClose={close}
      title={token ? t("settings.apiKeys.createdTitle") : t("settings.apiKeys.create")}
      centered
      size="lg"
    >
      {token ? (
        <Stack data-testid="api-key-reveal">
          <Alert color="yellow">{t("settings.apiKeys.copyNow")}</Alert>
          <TextInput
            readOnly
            value={token}
            aria-label={t("settings.apiKeys.token")}
            data-testid="api-key-token"
            styles={{ input: { fontFamily: "monospace" } }}
            onFocus={(e) => {
              e.currentTarget.select();
            }}
          />
          <Group justify="flex-end">
            <CopyButton value={token}>
              {({ copied, copy }) => (
                <Button
                  variant={copied ? "light" : "filled"}
                  leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  onClick={copy}
                >
                  {copied ? t("common.copied") : t("common.copy")}
                </Button>
              )}
            </CopyButton>
            <Button variant="default" onClick={close} data-testid="api-key-done">
              {t("common.close")}
            </Button>
          </Group>
        </Stack>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Stack>
            {create.isError && <Alert color="red">{apiError(create.error)}</Alert>}
            <TextInput
              label={t("settings.apiKeys.name")}
              description={t("settings.apiKeys.nameHint")}
              required
              maxLength={80}
              value={name}
              data-testid="api-key-name"
              onChange={(e) => {
                setName(e.currentTarget.value);
              }}
            />
            <Checkbox.Group
              label={t("settings.apiKeys.scopes")}
              value={scopes}
              onChange={(v) => {
                setScopes(API_SCOPES.filter((s) => v.includes(s)));
              }}
            >
              <Stack gap="xs" mt={4}>
                {available.map((s) => (
                  <Checkbox
                    key={s}
                    value={s}
                    label={t(SCOPE_LABEL[s])}
                    description={t(SCOPE_HINT[s])}
                    data-testid={`api-key-scope-${s}`}
                  />
                ))}
              </Stack>
            </Checkbox.Group>
            <Select
              label={t("settings.apiKeys.expiry")}
              data={expiryOptions}
              value={expiry}
              allowDeselect={false}
              comboboxProps={{ withinPortal: false }}
              onChange={(v) => {
                if (v) setExpiry(v);
              }}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                loading={create.isPending}
                disabled={name.trim() === "" || scopes.length === 0}
                data-testid="api-key-submit"
              >
                {t("settings.apiKeys.createSubmit")}
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </Modal>
  );
}
