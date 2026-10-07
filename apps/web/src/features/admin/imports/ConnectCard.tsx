import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconInfoCircle, IconKey } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApiError } from "../../../api/useApiError";
import { useForgetSamplyKey, useSamplyConnect, useSavedSamplyKey } from "./queries";

/**
 * Step 1: connect a Samply account with its API key. An admin's saved key (SPEC §25.11) is the
 * default when there is one; a typed key can be remembered for next time.
 */
export function ConnectCard({
  onConnected,
  onCancel,
}: {
  onConnected: (id: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const apiError = useApiError();
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(false);
  /** The admin chose to type a key although one is saved. */
  const [replacing, setReplacing] = useState(false);
  const saved = useSavedSamplyKey();
  const forget = useForgetSamplyKey();
  const connect = useSamplyConnect(onConnected);
  const savedKey = saved.data?.saved ? saved.data : null;
  const useSaved = savedKey !== null && !replacing;
  return (
    <Paper withBorder p="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          connect.mutate(useSaved ? { useSavedKey: true } : { apiKey: key.trim(), remember });
        }}
      >
        <Stack>
          <Title order={4}>{t("admin.import.connect.title")}</Title>
          {useSaved ? (
            <Paper withBorder p="sm" data-testid="samply-saved-key">
              <Group justify="space-between" gap="sm">
                <Group gap="xs" wrap="nowrap">
                  <IconKey size={18} aria-hidden />
                  <Text size="sm">
                    {t("admin.import.connect.useSaved", { last4: savedKey.last4 ?? "" })}
                  </Text>
                </Group>
                <Group gap="xs">
                  <Button
                    variant="default"
                    size="xs"
                    onClick={() => {
                      setReplacing(true);
                      setRemember(true);
                      connect.reset();
                    }}
                    data-testid="samply-replace-key"
                  >
                    {t("admin.import.connect.replace")}
                  </Button>
                  <Button
                    variant="subtle"
                    color="red"
                    size="xs"
                    loading={forget.isPending}
                    onClick={() => {
                      forget.mutate();
                      connect.reset();
                    }}
                    data-testid="samply-forget-key"
                  >
                    {t("admin.import.connect.forget")}
                  </Button>
                </Group>
              </Group>
            </Paper>
          ) : (
            <>
              <PasswordInput
                label={t("admin.import.connect.key")}
                description={t("admin.import.connect.keyHint")}
                value={key}
                onChange={(e) => {
                  setKey(e.currentTarget.value);
                }}
                autoComplete="off"
                required
                data-testid="samply-key"
              />
              <Checkbox
                label={t("admin.import.connect.remember")}
                description={t("admin.import.connect.rememberHint")}
                checked={remember}
                onChange={(e) => {
                  setRemember(e.currentTarget.checked);
                }}
                data-testid="samply-remember"
              />
              {savedKey !== null && (
                <Anchor
                  component="button"
                  type="button"
                  size="sm"
                  onClick={() => {
                    setReplacing(false);
                    connect.reset();
                  }}
                >
                  {t("admin.import.connect.backToSaved", { last4: savedKey.last4 ?? "" })}
                </Anchor>
              )}
            </>
          )}
          <Anchor
            href="https://samply.app/preferences/api"
            target="_blank"
            rel="noreferrer"
            size="sm"
          >
            {t("admin.import.connect.openSamply")}
          </Anchor>
          <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
            {t("admin.import.connect.ownedOnly")}
          </Alert>
          {connect.isError && <Alert color="red">{apiError(connect.error)}</Alert>}
          {forget.isError && <Alert color="red">{apiError(forget.error)}</Alert>}
          <Group justify="flex-end">
            <Button variant="default" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              loading={connect.isPending}
              disabled={saved.isPending || (!useSaved && key.trim().length < 8)}
              data-testid="samply-connect"
            >
              {t("admin.import.connect.submit")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Paper>
  );
}
