#!/usr/bin/env python3
"""生成网页牌桌的木纹底图（等宽木纹 + 暖光 + 暗角），输出 src/web/assets/table-bg.webp。

这是「没有自己的背景图」时的占位；想换风格就直接替换这张 webp，
尺寸保持 1600×1000、不要画边框和文字（桌子边框、底牌、按钮都由 play.css 画在上面）。

    python scripts/build-table-bg.py
"""
import os

from PIL import Image, ImageChops, ImageFilter, ImageOps

W, H = 1600, 1000
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'src', 'web', 'assets', 'table-bg.webp')


def grain(width_div: int) -> Image.Image:
    """横向拉长的噪声：木纹是一条条很长的细线。"""
    small = Image.effect_noise((max(2, W // width_div), max(2, H // 3)), 46)
    return small.resize((W, H), Image.BICUBIC).filter(ImageFilter.GaussianBlur(0.6))


def main() -> int:
    # 一层长纹 + 一层短纹：长短交错才不像拉伸的噪点。
    long_grain = grain(60)
    short_grain = grain(14)
    texture = Image.blend(long_grain, short_grain, 0.22)

    wood = ImageOps.colorize(texture, black='#3f2312', white='#a2653a', mid='#7a4a28')

    # 中间偏上的一片暖光（灯照在桌面上）。
    light = Image.new('L', (W, H))
    grad = Image.radial_gradient('L').resize((W, H), Image.BICUBIC)
    light = ImageChops.invert(grad)
    light = light.point(lambda v: int(v * 0.85))
    glow = ImageOps.colorize(light, black='#000000', white='#ffd9a0')
    wood = Image.blend(wood, ImageChops.screen(wood, glow.point(lambda v: int(v * 0.22))), 0.55)

    # 四角压暗，让中间那三张牌更跳。radial_gradient 是中间黑、边上白，正好当遮罩。
    vignette = Image.radial_gradient('L').resize((W, H), Image.BICUBIC)
    dark = Image.new('RGB', (W, H), '#1c0f06')
    wood = Image.composite(dark, wood, vignette.point(lambda v: int(max(0, v - 160) * 1.6)))

    wood = wood.filter(ImageFilter.GaussianBlur(0.4))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    wood.save(OUT, 'WEBP', quality=82, method=6)
    print(f'{OUT}  {os.path.getsize(OUT) / 1024:.0f} KB  {W}x{H}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
