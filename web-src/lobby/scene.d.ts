/** `web-src/lobby/scene.js` 的类型外壳。实现是 JS：它是从像素原型整段搬过来的，
 *  里面全是 canvas 调用，加类型只会让「改画面」多一道手续。 */

export declare const SCENE_W: number;
export declare const SCENE_H: number;
export declare const SCENE_LOOP: number;

export declare const BOOT_PH: {
  match: number;
  ignite: number;
  spreadEnd: number;
  fadeEnd: number;
  text1: number;
  text2: number;
  text3: number;
};

export interface SceneOptions {
  canvas: HTMLCanvasElement;
  whale?: { clips: Record<string, unknown> };
  images?: Record<string, CanvasImageSource>;
  light?: boolean;
}

export interface SceneHandle {
  canvas: HTMLCanvasElement;
  W: number;
  H: number;
  LOOP: number;
  /** 画一帧。t 是毫秒，外部只管累加。 */
  frame(t: number): void;
  /** 画一帧，并把「点灯」叠在上面。el 是开屏已经走了多少毫秒。 */
  frameBoot(t: number, el: number): void;
  set(next?: { whale?: boolean; coo?: boolean; light?: boolean; dbg?: boolean }): void;
}

export declare function createScene(opts: SceneOptions): SceneHandle;
