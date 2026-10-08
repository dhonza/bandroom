import {
  Button,
  Modal,
  Popover,
  Text,
  type ModalProps,
  type PopoverProps,
  type TransitionProps,
} from "@mantine/core";
import { useMediaQuery, useUncontrolled } from "@mantine/hooks";
import {
  cloneElement,
  isValidElement,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { PHONE_QUERY, SHORT_QUERY } from "../shell/mediaQueries";

const MEDIA = { getInitialValueInEffect: false } as const;

/**
 * Larger panels fill the screen (title bar + Close, page controls hidden behind them) on phones
 * and on short viewports (a phone in landscape), where a popover or a centered modal cannot fit.
 */
export function useSheetMode(): boolean {
  const phone = useMediaQuery(PHONE_QUERY, false, MEDIA);
  const short = useMediaQuery(SHORT_QUERY, false, MEDIA);
  return phone || short;
}

const SAFE = {
  top: "env(safe-area-inset-top, 0px)",
  bottom: "env(safe-area-inset-bottom, 0px)",
  left: "env(safe-area-inset-left, 0px)",
  right: "env(safe-area-inset-right, 0px)",
} as const;

const SHEET_TRANSITION: Partial<Omit<TransitionProps, "mounted">> = {
  transition: "slide-up",
  duration: 150,
};

/**
 * A Mantine `Modal` (same props) that goes full screen in sheet mode: no radius, a sticky title
 * bar with a 44 px Close button, a scrolling body and padding for the notch and the home
 * indicator. Elsewhere it is the call site's modal unchanged.
 */
export function AppModal({ closeButtonProps, ...props }: ModalProps) {
  const { t } = useTranslation();
  const sheet = useSheetMode();
  const close = { "aria-label": t("common.close"), ...closeButtonProps };
  if (!sheet) return <Modal {...props} closeButtonProps={close} />;
  return (
    <Modal
      {...props}
      fullScreen
      radius={0}
      transitionProps={SHEET_TRANSITION}
      closeButtonProps={{ size: 44, ...close }}
      styles={{
        header: {
          paddingTop: `calc(var(--mantine-spacing-xs) + ${SAFE.top})`,
          paddingBottom: "var(--mantine-spacing-xs)",
          paddingLeft: `calc(var(--mantine-spacing-md) + ${SAFE.left})`,
          paddingRight: `calc(var(--mantine-spacing-xs) + ${SAFE.right})`,
          borderBottom: "1px solid var(--mantine-color-default-border)",
          minHeight: 0,
        },
        body: {
          paddingTop: "var(--mantine-spacing-md)",
          paddingBottom: `calc(var(--mantine-spacing-xl) + ${SAFE.bottom})`,
          paddingLeft: `calc(var(--mantine-spacing-md) + ${SAFE.left})`,
          paddingRight: `calc(var(--mantine-spacing-md) + ${SAFE.right})`,
        },
      }}
      data-sheet="true"
    />
  );
}

/** What a panel's target gets: it toggles the panel and tells assistive tech about it. */
export interface PanelTargetProps {
  onClick: (event: MouseEvent<HTMLElement>) => void;
  "aria-haspopup": "dialog";
  "aria-expanded": boolean;
}

/**
 * A panel behind a button: a popover beside it on desktop, a full-screen `AppModal` titled
 * `title` in sheet mode. Uncontrolled by default; with `opened`/`onChange` the caller owns the
 * state (and an element target keeps its own onClick).
 */
export function PanelPopover({
  target,
  title,
  children,
  opened,
  defaultOpened = false,
  onChange,
  position = "bottom",
  width,
  withArrow,
  shadow = "md",
  testId,
}: {
  target: ReactElement | ((props: PanelTargetProps) => ReactElement);
  title: ReactNode;
  children: ReactNode;
  opened?: boolean;
  defaultOpened?: boolean;
  onChange?: (opened: boolean) => void;
  position?: PopoverProps["position"];
  width?: number;
  withArrow?: boolean;
  shadow?: PopoverProps["shadow"];
  /** data-testid of the dropdown (desktop) or the modal (sheet mode). */
  testId?: string;
}) {
  const sheet = useSheetMode();
  const controlled = opened !== undefined;
  const [isOpen, setOpen] = useUncontrolled({
    value: opened,
    defaultValue: defaultOpened,
    finalValue: false,
    onChange,
  });
  const targetProps: PanelTargetProps = {
    onClick: () => {
      setOpen(!isOpen);
    },
    "aria-haspopup": "dialog",
    "aria-expanded": isOpen,
  };
  let anchor: ReactElement;
  if (typeof target === "function") anchor = target(targetProps);
  else if (
    controlled ||
    !isValidElement<{ onClick?: (e: MouseEvent<HTMLElement>) => void }>(target)
  )
    anchor = target;
  else
    anchor = cloneElement(target, {
      onClick: (e: MouseEvent<HTMLElement>) => {
        target.props.onClick?.(e);
        targetProps.onClick(e);
      },
    });

  if (sheet) {
    return (
      <>
        {anchor}
        <AppModal
          opened={isOpen}
          onClose={() => {
            setOpen(false);
          }}
          title={title}
          data-testid={testId}
        >
          {children}
        </AppModal>
      </>
    );
  }
  return (
    <Popover
      opened={isOpen}
      onChange={setOpen}
      position={position}
      width={width}
      withArrow={withArrow}
      shadow={shadow}
      withinPortal
      trapFocus
    >
      <Popover.Target>{anchor}</Popover.Target>
      <Popover.Dropdown data-testid={testId}>{children}</Popover.Dropdown>
    </Popover>
  );
}

/**
 * A phone toolbar button: an icon above a tiny caption, at least 44 × 44 px; `active` fills it.
 */
export function CaptionButton({
  icon,
  caption,
  active = false,
  color,
  onClick,
  disabled,
  "aria-label": ariaLabel,
  "aria-pressed": ariaPressed,
  "data-testid": testId,
}: {
  icon: ReactNode;
  caption: string;
  active?: boolean;
  color?: string;
  onClick?: () => void;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-pressed"?: boolean;
  "data-testid"?: string;
}) {
  return (
    <Button
      variant={active ? "filled" : "subtle"}
      color={active ? color : "gray"}
      h="auto"
      mih={44}
      miw={44}
      px={6}
      py={4}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      data-testid={testId}
      styles={{
        inner: { height: "auto" },
        label: { flexDirection: "column", gap: 2, height: "auto", overflow: "visible" },
      }}
    >
      {icon}
      <Text component="span" fz={10} lh={1} fw={600} maw={84} truncate>
        {caption}
      </Text>
    </Button>
  );
}
