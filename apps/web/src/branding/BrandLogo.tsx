import { getMeta } from "@bandroom/shared";
import { Image } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useClientConfig } from "../config/ClientConfigContext";
import { useLinkMode } from "../links/linkMode";
import { brandingLogoUrl } from "../lib/media";

export const metaKey = ["meta"] as const;

/**
 * Hash of the branding logo (SPEC §25.1): from the server-injected config at first, then from
 * `/meta` so an admin's change shows without a reload. Link pages keep the injected value (their
 * API calls go below the link's root, where there is no `/meta`).
 */
export function useLogoHash(): string | null {
  const config = useClientConfig();
  const inLink = useLinkMode((s) => s.token !== null);
  const meta = useQuery({
    queryKey: metaKey,
    queryFn: ({ signal }) => api(getMeta, undefined, { signal }),
    enabled: !inLink,
    staleTime: 5 * 60_000,
  });
  return meta.data ? meta.data.logoHash : config.logoHash;
}

/** The logo at 32 px height, never wider than its container; `alt` names the instance. */
export function BrandLogo({ alt, height = 32 }: { alt: string; height?: number }) {
  const hash = useLogoHash();
  if (!hash) return null;
  return (
    <Image
      src={brandingLogoUrl(hash)}
      alt={alt}
      h={height}
      w="auto"
      fit="contain"
      data-testid="brand-logo"
      style={{ flex: "0 1 auto", minWidth: 0, maxWidth: "100%" }}
    />
  );
}
