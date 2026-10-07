import { generateFixtures } from "@bandroom/fixtures";

/**
 * Generates the audio/MIDI fixtures once before any worker starts, so parallel specs never race
 * to create them. The specs' own `generateFixtures()` calls then only check that the files exist.
 */
export default async function globalSetup(): Promise<void> {
  await generateFixtures();
}
