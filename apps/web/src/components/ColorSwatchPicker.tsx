import { PALETTE_COLORS } from "@bandroom/shared";
import { CheckIcon, ColorSwatch, Input, SimpleGrid } from "@mantine/core";
import { useTranslation } from "react-i18next";

export type PaletteColorName = (typeof PALETTE_COLORS)[number];

export function ColorSwatchPicker({
  value,
  onChange,
  label,
}: {
  value: PaletteColorName;
  onChange: (c: PaletteColorName) => void;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <Input.Wrapper label={label}>
      {/* 16 swatches: 4 × 4 on phones, 8 × 2 from the xs breakpoint; 44 px touch targets. */}
      <SimpleGrid
        cols={{ base: 4, xs: 8 }}
        spacing={6}
        verticalSpacing={6}
        mt={4}
        w="fit-content"
        role="radiogroup"
        aria-label={label}
      >
        {PALETTE_COLORS.map((c) => (
          <ColorSwatch
            key={c}
            component="button"
            type="button"
            role="radio"
            aria-checked={c === value}
            aria-label={t(`colors.${c}`)}
            color={`var(--mantine-color-${c}-6)`}
            size={44}
            style={{ cursor: "pointer", color: "#fff" }}
            onClick={() => {
              onChange(c);
            }}
          >
            {c === value && <CheckIcon style={{ width: 14, height: 14 }} />}
          </ColorSwatch>
        ))}
      </SimpleGrid>
    </Input.Wrapper>
  );
}
