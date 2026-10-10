/** The count-in toggle's icon (SPEC §31.5): four bars and a play triangle, Tabler-style stroke. */
export function CountInIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 9v6 M6.5 9v6 M10 9v6 M13.5 9v6 M17 7l5 5-5 5z" />
    </svg>
  );
}
