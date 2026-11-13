import type { SceneOptions } from './scene.js';

export const WHALE: NonNullable<SceneOptions['whale']>;
export function loadWhaleImages(base?: string): Promise<Record<string, HTMLImageElement>>;
