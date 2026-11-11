import type { StoryArchive, StoryCursor, StoryPage } from '../room/story-protocol.ts';

export function mountStoryArchive(root: HTMLElement, options: {
  list(cursor: StoryCursor | null): Promise<StoryPage>;
  detail(id: string): Promise<StoryArchive>;
  time(ts: number): string;
  active?: () => boolean;
}): void;
