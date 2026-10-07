import { Anchor } from "@mantine/core";
import type { ReactNode } from "react";
import { Link } from "react-router";

/** "← Parent" link above a page title, with a 44 px tall touch target (SPEC §11.1). */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Anchor
      component={Link}
      to={to}
      size="sm"
      c="dimmed"
      mih={44}
      style={{ display: "inline-flex", alignItems: "center", alignSelf: "flex-start" }}
    >
      ← {children}
    </Anchor>
  );
}
