/** 图片可绘制后再替换文字或背景底色。解码失败时由调用方保留原样。 */
export function decodeImage(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  return image.decode();
}
