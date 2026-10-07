import { Box, type BoxProps } from "@mantine/core";
import type { Ref } from "react";

/**
 * An invisible anchor for a menu opened programmatically: a button role for the aria attributes
 * Menu.Target adds, hidden from assistive tech.
 */
export function MenuAnchor({ ref, ...props }: BoxProps & { ref?: Ref<HTMLDivElement> }) {
  return <Box ref={ref} role="button" tabIndex={-1} aria-hidden {...props} />;
}
