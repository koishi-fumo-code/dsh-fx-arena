# -*- coding: utf-8 -*-
"""FX战士大肥鱼 商店图标：深蓝圆角底 + 左侧三根标准K线（影线穿实体）+ 右侧一条白色大肥鱼。"""
from PIL import Image, ImageDraw

def make(size):
    s = size
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = s * 0.22
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=(23, 74, 128, 255))
    d.rounded_rectangle([0, int(s * 0.5), s - 1, s - 1], radius=r, fill=(13, 52, 96, 255))

    # 三根 K 线：影线（细白线）从最高画到最低，实体（带描边方块）居中穿过
    cw = s * 0.105
    lw = max(2, int(s * 0.018))
    candles = [
        # (x 中心, 影线顶, 影线底, 实体顶, 实体底, 涨?)
        (0.17, 0.24, 0.72, 0.36, 0.58, True),
        (0.33, 0.18, 0.66, 0.28, 0.50, False),
        (0.49, 0.30, 0.78, 0.46, 0.66, True),
    ]
    for xc, wt, wb, bt, bb, up in candles:
        x = s * xc
        col = (34, 197, 94, 255) if up else (239, 68, 68, 255)
        d.line([(x, s * wt), (x, s * wb)], fill=(240, 246, 252, 235), width=lw)
        d.rectangle([x - cw / 2, s * bt, x + cw / 2, s * bb], fill=col,
                    outline=(255, 255, 255, 230), width=max(2, int(s * 0.012)))

    # 右侧白色大肥鱼（微微上仰 = 做多冲线喵），不与 K 线重叠
    fx, fy = s * 0.755, s * 0.60
    fw, fh = s * 0.36, s * 0.21
    d.ellipse([fx - fw / 2, fy - fh / 2, fx + fw / 2, fy + fh / 2],
              fill=(238, 245, 252, 255))
    # 尾鳍：接在鱼身左端偏上，画在鱼身下面（先画尾再被身盖住根部更自然 → 这里直接贴左缘）
    d.polygon([(fx - fw / 2 + s * 0.02, fy),
               (fx - fw / 2 - s * 0.09, fy - s * 0.075),
               (fx - fw / 2 - s * 0.09, fy + s * 0.075)], fill=(238, 245, 252, 255))
    # 背鳍
    d.polygon([(fx - s * 0.015, fy - fh / 2 + s * 0.008),
               (fx + s * 0.05, fy - fh / 2 - s * 0.05),
               (fx + s * 0.085, fy - fh / 2 + s * 0.01)], fill=(238, 245, 252, 255))
    # 眼睛 + 腮红（傲娇小萝莉）
    er = s * 0.024
    d.ellipse([fx + s * 0.09 - er, fy - s * 0.035 - er, fx + s * 0.09 + er, fy - s * 0.035 + er],
              fill=(23, 74, 128, 255))
    d.ellipse([fx + s * 0.055, fy + s * 0.015, fx + s * 0.115, fy + s * 0.05],
              fill=(255, 150, 170, 190))
    # 小嘴
    d.arc([fx + fw * 0.30, fy - s * 0.01, fx + fw * 0.44, fy + s * 0.05], 20, 160,
          fill=(23, 74, 128, 200), width=max(2, int(s * 0.012)))
    return img

for size, path in [(180, 'assets/icon-180.png'), (512, 'assets/icon-512.png')]:
    im = make(size)
    im.save(path)
    print(path, im.size)
