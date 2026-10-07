import { getProjectQueue, type QueueItem } from "@bandroom/shared";
import { api } from "../api/client";
import type { QueueEntry } from "./listenStore";

export function toQueueEntries(
  items: QueueItem[],
  project: { id: string; name: string; imageHash: string | null },
): QueueEntry[] {
  return items.map((i) => ({
    songId: i.songId,
    title: i.title,
    subtitle: i.subtitle,
    projectId: project.id,
    projectName: project.name,
    imageHash: project.imageHash,
    listen: i.listen,
  }));
}

export async function fetchProjectQueue(project: {
  id: string;
  name: string;
  imageHash: string | null;
}): Promise<QueueEntry[]> {
  const { items } = await api(getProjectQueue, { params: { id: project.id } });
  return toQueueEntries(items, project);
}
