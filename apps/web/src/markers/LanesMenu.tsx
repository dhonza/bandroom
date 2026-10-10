import { ActionIcon, Checkbox, Menu, Tooltip } from "@mantine/core";
import { IconLayoutRows } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  setAllLanes,
  TOP_LANES,
  toggleLane,
  useLaneVisibility,
  type TopLane,
} from "../timeline/laneVisibility";

const LABEL_KEYS = {
  sections: "markers.sections",
  comments: "comments.lane",
} as const satisfies Record<TopLane, string>;

/**
 * The lane checkboxes plus "Show all" / "Hide all" (SPEC §11.3), for a menu that stays open on
 * clicks: the timeline corner's lanes menu and the phone transport's options menu.
 */
export function LaneMenuItems() {
  const { t } = useTranslation();
  const hidden = useLaneVisibility((s) => s.hidden);
  return (
    <>
      <Menu.Label>{t("markers.lanes")}</Menu.Label>
      {TOP_LANES.map((key) => (
        <Menu.Item
          key={key}
          leftSection={
            <Checkbox
              size="xs"
              checked={!hidden[key]}
              readOnly
              tabIndex={-1}
              aria-hidden
              style={{ pointerEvents: "none" }}
            />
          }
          onClick={() => {
            toggleLane(key);
          }}
          role="menuitemcheckbox"
          aria-checked={!hidden[key]}
          data-testid={`lane-toggle-${key}`}
        >
          {t(LABEL_KEYS[key])}
        </Menu.Item>
      ))}
      <Menu.Item
        onClick={() => {
          setAllLanes(false);
        }}
        data-testid="lanes-show-all"
      >
        {t("markers.showAllLanes")}
      </Menu.Item>
      <Menu.Item
        onClick={() => {
          setAllLanes(true);
        }}
        data-testid="lanes-hide-all"
      >
        {t("markers.hideAllLanes")}
      </Menu.Item>
    </>
  );
}

/** The timeline corner's button that shows or hides the top lanes. */
export function LanesMenu() {
  const { t } = useTranslation();
  return (
    <Menu position="bottom-start" withinPortal closeOnItemClick={false}>
      <Menu.Target>
        <Tooltip label={t("markers.lanesMenu")} openDelay={400}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={t("markers.lanesMenu")}
            data-testid="lanes-menu"
          >
            <IconLayoutRows size={16} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown miw={200}>
        <LaneMenuItems />
      </Menu.Dropdown>
    </Menu>
  );
}
