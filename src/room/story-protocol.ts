export const STORY_NOTE_LIMIT = 80;
export const STORY_CHAT_LIMIT = 500;
export const STORY_PART_LIMIT = 1000;
export const STORY_TITLE_LIMIT = 60;
export const STORY_DRAW_SIZE = 10;
export const STORY_TALK_MS = 8 * 60_000;
export const STORY_TOTAL_MS = 10 * 60_000;
export const STORY_QUEUE_MS = 60_000;
export const STORY_RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface StoryPart {
  seq: number;
  text: string;
}

export interface StorySummary {
  id: string;
  speaker: string;
  title: string;
  startedAt: number;
  endedAt: number;
  snacks: number;
}

export interface StoryArchive extends StorySummary {
  parts: StoryPart[];
}

export interface StoryLiveHint {
  id: string;
  speaker: string;
  title: string;
  endsAt: number;
}

export interface StoryChatPage {
  round: Pick<StorySummary, 'id' | 'speaker' | 'title'> | null;
  messages: { seq: number; name: string; text: string }[];
  before: number | null;
}

export interface StoryState {
  now: number;
  chat?: StoryChatPage;
  preview?: { round: string; notes: { name: string; text: string }[] };
  queue: { position: number | null; readyUntil: number | null; open: boolean };
  round: null | {
    id: string;
    speaker: string;
    title: string;
    startedAt: number;
    notesAt: number;
    endsAt: number;
    speaking: boolean;
    listening: boolean;
    parts: StoryPart[];
    snacks: number;
    sentSnack: boolean;
    note: { text: string; status: 'waiting' | 'delivered' | 'skipped' } | null;
    batch: { name: string; text: string }[] | null;
  };
}

export interface StoryCursor {
  endedAt: number;
  id: string;
}

export interface StoryPage {
  rounds: StorySummary[];
  next: StoryCursor | null;
}

export interface StoryNotice {
  now: number;
  queued: boolean;
  readyUntil: number | null;
  round: null | {
    id: string;
    notesAt: number;
    endsAt: number;
    batch: { name: string; text: string }[] | null;
    snacks: number;
  };
}

export const STORY_ACTIONS = ['queue', 'cancel', 'start', 'listen', 'speak', 'note', 'peek_notes', 'snack', 'finish', 'chat'] as const;
