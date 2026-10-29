/**
 * 客厅注册表：多客厅的目录与生命周期。
 *
 * 一个进程里可以有很多客厅；这里只存“客厅是什么、归谁、谁能看见、多大”，
 * 不存席位/事件/牌桌（那些在每客厅的 RoomKernel 里）。
 * 空的客厅也保留；长期不活跃由外层归档，不在这里自动删。
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isCooId } from './ledger.ts';

export const ROOM_FILE = 'rooms.json';
export const DEFAULT_ROOM_LIMIT = 100;
export const DEFAULT_ROOMS_PER_OWNER = 3;
export const SYSTEM_OWNER = 'system-owner';

export type RoomVisibility = 'public' | 'unlisted' | 'private';

export const ROOM_VISIBILITIES: readonly RoomVisibility[] = ['public', 'unlisted', 'private'];

export interface RoomRecord {
  id: string;
  name: string;
  topic: string;
  ownerCooId: string;
  visibility: RoomVisibility;
  maxSeats: number;
  createdAt: number;
  lastActiveAt: number;
  archivedAt?: number;
}

export interface RoomRegistryOptions {
  file?: string;
  now?: () => number;
  limit?: number;
  perOwnerLimit?: number;
}

export interface CreateRoomInput {
  name: string;
  ownerCooId: string;
  visibility?: RoomVisibility;
  topic?: string;
  maxSeats?: number;
}

export interface UpdateRoomInput {
  name?: string;
  topic?: string;
  visibility?: RoomVisibility;
  maxSeats?: number;
}

interface RoomState {
  version: 1;
  rooms: RoomRecord[];
}

const MAX_NAME = 32;
const MAX_TOPIC = 80;
const MIN_SEATS = 2;
const MAX_SEATS = 12;

const isVisibility = (value: unknown): value is RoomVisibility => (
  typeof value === 'string' && (ROOM_VISIBILITIES as readonly string[]).includes(value)
);

const cleanName = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (text.length < 2 || text.length > MAX_NAME) throw new Error(`客厅名字要 ${2}–${MAX_NAME} 个字`);
  return text;
};

const cleanTopic = (value: unknown): string => (
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_TOPIC) : ''
);

const cleanSeats = (value: unknown, fallback = 8): number => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < MIN_SEATS || (value as number) > MAX_SEATS) {
    throw new Error(`席位上限要在 ${MIN_SEATS}–${MAX_SEATS} 之间`);
  }
  return value as number;
};

const makeId = (): string => `r-${randomBytes(6).toString('base64url')}`;

const isRoom = (value: unknown): value is RoomRecord => {
  if (!value || typeof value !== 'object') return false;
  const room = value as Partial<RoomRecord>;
  return typeof room.id === 'string' && room.id.length > 0
    && typeof room.name === 'string' && room.name.length >= 2
    && typeof room.topic === 'string'
    && (room.ownerCooId === SYSTEM_OWNER || isCooId(room.ownerCooId))
    && isVisibility(room.visibility)
    && Number.isInteger(room.maxSeats) && (room.maxSeats ?? 0) >= MIN_SEATS && (room.maxSeats ?? 0) <= MAX_SEATS
    && Number.isFinite(room.createdAt)
    && Number.isFinite(room.lastActiveAt)
    && (room.archivedAt === undefined || Number.isFinite(room.archivedAt));
};

export class RoomRegistry {
  private rooms: RoomRecord[] = [];
  private readonly file?: string;
  private readonly now: () => number;
  private readonly limit: number;
  private readonly perOwnerLimit: number;

  constructor(options: RoomRegistryOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.limit = options.limit ?? DEFAULT_ROOM_LIMIT;
    this.perOwnerLimit = options.perOwnerLimit ?? DEFAULT_ROOMS_PER_OWNER;
  }

  static load(options: RoomRegistryOptions = {}): RoomRegistry {
    const registry = new RoomRegistry(options);
    if (!options.file) return registry;
    try {
      const raw = JSON.parse(readFileSync(options.file, 'utf8')) as Partial<RoomState>;
      if (raw.version !== 1 || !Array.isArray(raw.rooms)) return registry;
      const seen = new Set<string>();
      for (const entry of raw.rooms) {
        if (!isRoom(entry) || seen.has(entry.id)) continue;
        seen.add(entry.id);
        registry.rooms.push({
          id: entry.id,
          name: entry.name,
          topic: entry.topic,
          ownerCooId: entry.ownerCooId,
          visibility: entry.visibility,
          maxSeats: entry.maxSeats,
          createdAt: Number(entry.createdAt) || 0,
          lastActiveAt: Number(entry.lastActiveAt) || 0,
          ...(entry.archivedAt === undefined ? {} : { archivedAt: Number(entry.archivedAt) || 0 }),
        });
        if (registry.rooms.length >= registry.limit) break;
      }
    } catch { /* 坏文件从空目录开始，不阻断客厅 */ }
    return registry;
  }

  get size(): number {
    return this.rooms.length;
  }

  get(id: string): RoomRecord | undefined {
    return this.rooms.find((room) => room.id === id);
  }

  /** id 优先，其次大小写不敏感的名字；重名取第一个。 */
  resolve(value: string): RoomRecord | undefined {
    const needle = typeof value === 'string' ? value.trim() : '';
    if (!needle) return undefined;
    return this.get(needle) ?? this.rooms.find((room) => room.name.toLowerCase() === needle.toLowerCase());
  }

  list(options: { includeArchived?: boolean; visibility?: RoomVisibility } = {}): RoomRecord[] {
    return this.rooms.filter((room) => {
      if (!options.includeArchived && room.archivedAt !== undefined) return false;
      if (options.visibility && room.visibility !== options.visibility) return false;
      return true;
    });
  }

  activeRoomsOf(cooId: string): RoomRecord[] {
    return this.rooms.filter((room) => room.ownerCooId === cooId && room.archivedAt === undefined);
  }

  isOwner(room: RoomRecord, cooId: string): boolean {
    return room.ownerCooId === cooId;
  }

  create(input: CreateRoomInput): RoomRecord {
    if (!isCooId(input.ownerCooId)) throw new Error('主人 cooId 格式不对');
    const name = cleanName(input.name);
    const visibility = input.visibility ?? 'unlisted';
    if (!isVisibility(visibility)) throw new Error('可见性不对');
    const maxSeats = cleanSeats(input.maxSeats);
    if (this.rooms.length >= this.limit) throw new Error('客厅数量到了上限');
    if (this.activeRoomsOf(input.ownerCooId).length >= this.perOwnerLimit) {
      throw new Error(`一个 Coo 最多同时开 ${this.perOwnerLimit} 个客厅`);
    }

    const room: RoomRecord = {
      id: this.uniqueId(),
      name,
      topic: cleanTopic(input.topic),
      ownerCooId: input.ownerCooId,
      visibility,
      maxSeats,
      createdAt: this.now(),
      lastActiveAt: this.now(),
    };
    this.rooms.push(room);
    this.save();
    return room;
  }

  /** 默认客厅/内置客厅用；重复调用不重复建。 */
  ensureDefault(id: string, name: string, maxSeats = 8): RoomRecord {
    const existing = this.get(id);
    if (existing) return existing;
    if (this.rooms.length >= this.limit) throw new Error('客厅数量到了上限');
    const room: RoomRecord = {
      id,
      name: cleanName(name),
      topic: '',
      ownerCooId: SYSTEM_OWNER,
      visibility: 'public',
      maxSeats: cleanSeats(maxSeats),
      createdAt: this.now(),
      lastActiveAt: this.now(),
    };
    this.rooms.push(room);
    this.save();
    return room;
  }

  update(id: string, patch: UpdateRoomInput): RoomRecord | null {
    const room = this.get(id);
    if (!room) return null;
    if (patch.name !== undefined) room.name = cleanName(patch.name);
    if (patch.topic !== undefined) room.topic = cleanTopic(patch.topic);
    if (patch.visibility !== undefined) {
      if (!isVisibility(patch.visibility)) throw new Error('可见性不对');
      room.visibility = patch.visibility;
    }
    if (patch.maxSeats !== undefined) room.maxSeats = cleanSeats(patch.maxSeats);
    room.lastActiveAt = this.now();
    this.save();
    return room;
  }

  touch(id: string): void {
    const room = this.get(id);
    if (!room) return;
    room.lastActiveAt = this.now();
    this.save();
  }

  archive(id: string): RoomRecord | null {
    const room = this.get(id);
    if (!room) return null;
    if (room.archivedAt === undefined) {
      room.archivedAt = this.now();
      this.save();
    }
    return room;
  }

  unarchive(id: string): RoomRecord | null {
    const room = this.get(id);
    if (!room) return null;
    if (room.archivedAt !== undefined) {
      delete room.archivedAt;
      room.lastActiveAt = this.now();
      this.save();
    }
    return room;
  }

  toJSON(): RoomState {
    return { version: 1, rooms: this.rooms };
  }

  private uniqueId(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = makeId();
      if (!this.get(id)) return id;
    }
    throw new Error('客厅 id 生成失败');
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.toJSON())}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
  }
}
