#!/usr/bin/env python3
"""把一套 54 张扑克 PNG 压成网页用的一张雪碧图。

牌面来源见 src/web/assets/cards/README.md（不随仓库分发）。
用法：
    python scripts/build-card-sprite.py <解压后的素材目录>

素材目录里应有 PNG/ 子目录，文件名形如 SpadeA.png、Heart10.png、JOKER-A.png。
输出 src/web/assets/cards/cards.webp：13 列（A 2..K）× 5 行（♠ ♥ ♣ ♦ + 王），
每格 200×279；网页用 background-position 取格子，只需要一次请求。
"""
import os
import sys

from PIL import Image

CELL_W, CELL_H = 200, 279
COLS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']
ROWS = ['Spade', 'Heart', 'Club', 'Diamond']
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'src', 'web', 'assets', 'cards', 'cards.webp')


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    root = sys.argv[1]
    png_dirs = [os.path.join(root, 'PNG'), root]
    png_dir = next((p for p in png_dirs if os.path.isdir(p)), None)
    if not png_dir:
        print('找不到 PNG/ 目录：', root)
        return 1

    sheet = Image.new('RGBA', (CELL_W * len(COLS), CELL_H * len(ROWS) + CELL_H), (0, 0, 0, 0))
    missing = []
    for row, suit in enumerate(ROWS):
        for col, rank in enumerate(COLS):
            name = f'{suit}{rank}.png'
            path = os.path.join(png_dir, name)
            if not os.path.exists(path):
                missing.append(name)
                continue
            card = Image.open(path).convert('RGBA').resize((CELL_W, CELL_H), Image.LANCZOS)
            sheet.paste(card, (col * CELL_W, row * CELL_H), card)

    # A 是彩色那张（大王），B 是黑白那张（小王）；顺序决定第 5 行的列号，跟网页一致。
    jokers = {'BJ': 'JOKER-A.png', 'SJ': 'JOKER-B.png'}
    for col, name in enumerate(jokers.values()):
        path = os.path.join(png_dir, name)
        if not os.path.exists(path):
            missing.append(name)
            continue
        card = Image.open(path).convert('RGBA').resize((CELL_W, CELL_H), Image.LANCZOS)
        sheet.paste(card, (col * CELL_W, len(ROWS) * CELL_H), card)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    sheet.save(OUT, 'WEBP', quality=86, method=6)
    print(f'{OUT}  {os.path.getsize(OUT) / 1024:.0f} KB  {sheet.size[0]}x{sheet.size[1]}')
    if missing:
        print('缺这些牌：', '、'.join(missing))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
