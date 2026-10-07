/** Branding logo rules (SPEC §25.1). */

/** Widest allowed logo, as width : height. */
export const LOGO_MAX_ASPECT = 4;

/** Stored logo height in px (shown at half that on 2× screens). */
export const LOGO_HEIGHT = 64;

/** Whether an image of this size may be the logo (EXIF orientation already applied). */
export function logoAspectAllowed(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= height * LOGO_MAX_ASPECT;
}

/** Public API path of the logo (relative to the API prefix); anyone may load it. */
export function brandingLogoPath(hash: string): string {
  return `/branding/logo/${hash}`;
}
