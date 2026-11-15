import { shallowReactive } from 'vue';
import facesUrl from '../assets/mahjong/faces.webp';
import boardUrl from '../assets/table/mahjong-board.webp';
import clothUrl from '../assets/table/cloth.webp';
import { tableImage } from './image.ts';

export const mahjongArt = shallowReactive({ board: '', faces: '', cloth: '' });
const loadBoard = tableImage(boardUrl, () => { mahjongArt.board = `url(${boardUrl})`; });
const loadFaces = tableImage(facesUrl, () => { mahjongArt.faces = `url(${facesUrl})`; });
const loadCloth = tableImage(clothUrl, () => { mahjongArt.cloth = `url(${clothUrl})`; }, { priority: 'low' });

/** 等人和进桌共用同一批请求。各张图就绪即可显示。 */
export function preloadMahjongArt(visible = false): void {
  loadBoard(visible);
  loadFaces(visible);
  loadCloth(visible);
}
