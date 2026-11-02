/** 轮播纯规则的桥：逻辑仍住在旧版 `room-carousel.js`（单测也在那边）。 */
// @ts-ignore 旧模块是 JS，没有类型声明。
import { createRoomCarousel as create } from '../../src/web/room-carousel.js';
import type { RoomCard } from '../api/types.ts';

export interface CarouselModel {
  rooms: RoomCard[];
  index: number;
  current: RoomCard | null;
  paused: boolean;
}

export interface Carousel {
  snapshot(): CarouselModel;
  setRooms(rooms: RoomCard[]): void;
  setActive(value: boolean): void;
  setBlocked(value: boolean): void;
  setPaused(value: boolean): void;
  select(index: number): void;
  move(delta: number): void;
  dispose(): void;
}

export function createRoomCarousel(
  onChange: (model: CarouselModel) => void,
  options: { interval?: number; paused?: boolean } = {},
): Carousel {
  return create(onChange, options) as Carousel;
}
