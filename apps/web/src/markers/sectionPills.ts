import { create } from "zustand";

/**
 * Whether the section pills are shown (SPEC §31.3): off by default, remembered per user and
 * device. Browser storage may be unavailable (private mode); the choice then lasts for the page.
 */
const PREFIX = "bandroom.sectionPills.";

function load(userId: string): boolean {
  try {
    return localStorage.getItem(PREFIX + userId) === "1";
  } catch {
    return false;
  }
}

function save(userId: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(PREFIX + userId, "1");
    else localStorage.removeItem(PREFIX + userId);
  } catch {
    // per-device convenience only
  }
}

/** Choices made on this page, by user id (the rest are read from storage). */
export const useSectionPills = create<{ byUser: Readonly<Record<string, boolean>> }>(() => ({
  byUser: {},
}));

/** Whether `userId` (link visitors: a shared key) has the pills on. */
export function sectionPillsOn(userId: string): boolean {
  return useSectionPills.getState().byUser[userId] ?? load(userId);
}

export function useSectionPillsOn(userId: string): boolean {
  return useSectionPills((s) => s.byUser[userId] ?? load(userId));
}

export function setSectionPills(userId: string, on: boolean): void {
  save(userId, on);
  useSectionPills.setState((s) => ({ byUser: { ...s.byUser, [userId]: on } }));
}

export function toggleSectionPills(userId: string): void {
  setSectionPills(userId, !sectionPillsOn(userId));
}
