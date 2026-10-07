import { ActionIcon, Button, Group, Kbd, Stack, Table, Text } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Section } from "../../components/Section";
import {
  assignKey,
  keyFor,
  keyLabel,
  loadKeyMap,
  PEDAL_ACTIONS,
  saveKeyMap,
  type KeyMap,
  type PedalAction,
} from "../../markers/keymap";
import { setHelpOpen } from "../../markers/store";
import { ShortcutHelp } from "../../markers/shortcuts";

/**
 * Keyboard and pedal mapping (SPEC §11.4): Bluetooth page-turner pedals send PageUp/PageDown,
 * arrows or Space; any key can be mapped to a song-page action. Stored per device.
 */
export function KeyboardSection() {
  const { t } = useTranslation();
  const [map, setMap] = useState<KeyMap>(loadKeyMap);
  const [listening, setListening] = useState<PedalAction | null>(null);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setListening(null);
        return;
      }
      if (
        ["ShiftLeft", "ShiftRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight"].includes(e.code)
      )
        return;
      const next = assignKey(map, listening, e.code);
      saveKeyMap(next);
      setMap(next);
      setListening(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [listening, map]);

  const update = (next: KeyMap) => {
    saveKeyMap(next);
    setMap(next);
  };

  return (
    <Section
      title={t("settings.keyboard.title")}
      description={t("settings.keyboard.description")}
      testId="settings-keyboard"
    >
      <Stack gap="sm">
        <Table>
          <Table.Tbody>
            {PEDAL_ACTIONS.map((a) => {
              const code = keyFor(map, a);
              const label = t(`settings.keyboard.actions.${a}`);
              return (
                <Table.Tr key={a} data-testid="keymap-row" data-action={a}>
                  <Table.Td>
                    <Text size="sm">{label}</Text>
                  </Table.Td>
                  <Table.Td>
                    {code ? (
                      <Kbd>{keyLabel(code)}</Kbd>
                    ) : (
                      <Text size="sm" c="dimmed">
                        {t("settings.keyboard.none")}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      <Button
                        size="sm"
                        h={44}
                        variant={listening === a ? "filled" : "default"}
                        onClick={() => {
                          setListening(listening === a ? null : a);
                        }}
                        data-testid="keymap-assign"
                      >
                        {listening === a
                          ? t("settings.keyboard.pressKey")
                          : t("settings.keyboard.assign")}
                      </Button>
                      {code && (
                        <ActionIcon
                          size={44}
                          variant="subtle"
                          color="gray"
                          aria-label={t("settings.keyboard.clear", { action: label })}
                          onClick={() => {
                            update(assignKey(map, a, null));
                          }}
                        >
                          <IconX size={16} />
                        </ActionIcon>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
        <Group gap="xs">
          <Button
            variant="subtle"
            h={44}
            onClick={() => {
              setHelpOpen(true);
            }}
          >
            {t("settings.keyboard.showShortcuts")}
          </Button>
          {Object.keys(map).length > 0 && (
            <Button
              variant="subtle"
              color="red"
              h={44}
              onClick={() => {
                update({});
              }}
            >
              {t("settings.keyboard.reset")}
            </Button>
          )}
        </Group>
      </Stack>
      <ShortcutHelp />
    </Section>
  );
}
