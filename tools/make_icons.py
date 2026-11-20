# -*- coding: utf-8 -*-
"""경희대MTA태권도 PWA 아이콘 생성기 — 외부 이미지 없이 코드로만 그립니다.

출력: icons/icon-192.png, icons/icon-512.png (any)
      icons/icon-maskable-192.png, icons/icon-maskable-512.png (maskable, 안전영역 준수)
      icons/apple-touch-icon.png (180, 아이폰 홈 화면용 꽉 찬 사각)
"""
import os
from PIL import Image, ImageDraw, ImageFont

NAVY_TOP = (22, 41, 79)      # #16294f
NAVY_BOT = (13, 27, 62)      # #0d1b3e
RED = (226, 59, 59)          # #e23b3b
RED_DARK = (194, 47, 47)     # #c22f2f
WHITE = (255, 255, 255)
FONT = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'

S = 8  # 슈퍼샘플링 배율


def gradient(size, top, bot):
    img = Image.new('RGB', (1, size), top)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        d.point((0, y), tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return img.resize((size, size))


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def center_text(draw, text, font, cy, size, fill=WHITE):
    box = draw.textbbox((0, 0), text, font=font)
    w = box[2] - box[0]
    h = box[3] - box[1]
    draw.text(((size - w) / 2 - box[0], cy - h / 2 - box[1]), text, font=font, fill=fill)
    return w, h


def draw_icon(size, maskable=False):
    """마스터 캔버스를 size*S로 그린 뒤 다운샘플."""
    W = size * S
    img = gradient(W, NAVY_TOP, NAVY_BOT).convert('RGBA')

    # 안쪽 그림 영역: maskable이면 안전영역(중앙 80% 원) 안에만 들어가도록 축소
    scale = 0.72 if maskable else 0.86
    cw = int(W * scale)          # 그림 폭
    left = (W - cw) // 2

    layer = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # ── 'MTA' 글자 (위쪽)
    fsize = int(cw * 0.44)
    font = ImageFont.truetype(FONT, fsize)
    cy = int(W * 0.42)
    center_text(d, 'MTA', font, cy, W)

    # ── 띠(belt): 빨간 띠 + 가운데 매듭 + 아래로 늘어진 띠 끝 두 갈래
    bw = int(cw * 0.90)
    bh = max(5 * S, int(cw * 0.095))
    bx0 = (W - bw) // 2
    by0 = int(W * 0.625)
    bcx = W // 2
    d.rounded_rectangle([bx0, by0, bx0 + bw, by0 + bh], radius=int(bh / 2), fill=RED)

    # 띠 양 끝을 살짝 둥글게 마무리하고, 매듭 아래로 짧은 띠 끝 두 갈래만 남깁니다
    tw = int(bh * 0.50)
    th = int(bh * 1.15)
    for dx, ang in ((-1, 24), (1, -24)):
        tail = Image.new('RGBA', (tw, th), (0, 0, 0, 0))
        td = ImageDraw.Draw(tail)
        td.rounded_rectangle([0, 0, tw - 1, th - 1], radius=int(tw * 0.34), fill=RED)
        tail = tail.rotate(ang, expand=True, resample=Image.BICUBIC)
        tx = bcx + dx * int(bh * 0.55) - tail.width // 2
        ty = by0 + bh - int(bh * 0.30)
        layer.alpha_composite(tail, (tx, ty))

    # 매듭: 흰 원 + 빨간 대각선 (작은 크기에서도 띠·매듭으로 읽히게)
    kr = int(bh * 0.78)
    d.ellipse([bcx - kr, by0 + bh // 2 - kr, bcx + kr, by0 + bh // 2 + kr], fill=WHITE)
    d.line([bcx - kr * 0.5, by0 + bh // 2 + kr * 0.5, bcx + kr * 0.5, by0 + bh // 2 - kr * 0.5],
           fill=RED, width=max(2 * S, int(kr * 0.34)))

    img = Image.alpha_composite(img, layer)
    img = img.resize((size, size), Image.LANCZOS)

    if not maskable:
        img.putalpha(rounded_mask(size, int(size * 0.22)))
    return img


def main():
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'icons')
    os.makedirs(out, exist_ok=True)
    jobs = [
        ('icon-192.png', 192, False),
        ('icon-512.png', 512, False),
        ('icon-maskable-192.png', 192, True),
        ('icon-maskable-512.png', 512, True),
        ('apple-touch-icon.png', 180, True),   # iOS는 자체 마스크를 씌우므로 꽉 찬 사각 + 여백
        ('favicon-32.png', 32, False),
    ]
    for name, size, maskable in jobs:
        icon = draw_icon(size, maskable)
        path = os.path.join(out, name)
        icon.save(path, 'PNG', optimize=True)
        print('%-26s %4dpx %7d bytes' % (name, size, os.path.getsize(path)))


if __name__ == '__main__':
    main()
