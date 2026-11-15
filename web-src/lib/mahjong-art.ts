import { shallowReactive } from 'vue';
import facesUrl from '../assets/mahjong/faces.webp';
import boardUrl from '../assets/table/mahjong-board.webp';
import { decodeImage } from './image.ts';

export const mahjongArt = shallowReactive({ board: '', faces: '' });
let requested = false;

/** 等人和进桌共用同一批请求。各张图就绪即可显示。 */
export function preloadMahjongArt(): void {
  if (requested) return;
  requested = true;
  void decodeImage(boardUrl).then(() => { mahjongArt.board = `url(${boardUrl})`; }, () => {});
  void decodeImage(facesUrl).then(() => { mahjongArt.faces = `url(${facesUrl})`; }, () => {});
}
