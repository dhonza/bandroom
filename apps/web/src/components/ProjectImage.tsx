import { Box, Image, Text } from "@mantine/core";
import { blobUrl } from "../lib/media";

/** Project image (512 px WebP) or a colored placeholder with the first letter. */
export function ProjectImage({
  name,
  color,
  imageHash,
  size,
  radius = "var(--mantine-radius-md)",
}: {
  name: string;
  color: string;
  imageHash: string | null;
  size: number | string;
  radius?: string;
}) {
  if (imageHash) {
    return (
      <Image
        src={blobUrl(imageHash)}
        alt=""
        w={size}
        h={size}
        fit="cover"
        style={{ borderRadius: radius, flexShrink: 0 }}
      />
    );
  }
  return (
    <Box
      w={size}
      h={size}
      aria-hidden
      style={{
        flexShrink: 0,
        borderRadius: radius,
        background: `linear-gradient(135deg, var(--mantine-color-${color}-7), var(--mantine-color-${color}-4))`,
        display: "grid",
        placeItems: "center",
      }}
    >
      <Text fw={800} c="white" size="xl" style={{ textShadow: "0 1px 2px rgb(0 0 0 / 40%)" }}>
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </Box>
  );
}
