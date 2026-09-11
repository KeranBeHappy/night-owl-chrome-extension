"""Night Owl 图标生成器 —— 仅用 Python 标准库，输出 16/48/128 三个尺寸的 PNG。"""
import os
import struct
import zlib

SS = 3                      # 超采样倍数
BG = (38, 42, 54)           # 深蓝灰底
MOON = (245, 200, 106)      # 暖黄月亮


def in_rounded_rect(x, y, size, radius):
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= radius * radius


def in_moon(x, y, size):
    cx1, cy1, r1 = 0.47 * size, 0.53 * size, 0.285 * size
    cx2, cy2, r2 = 0.63 * size, 0.39 * size, 0.275 * size
    d1 = (x - cx1) ** 2 + (y - cy1) ** 2
    d2 = (x - cx2) ** 2 + (y - cy2) ** 2
    return d1 <= r1 * r1 and d2 > r2 * r2


def render(size):
    radius = size * 0.24
    step = 1.0 / SS
    total = SS * SS
    out = bytearray()

    for py in range(size):
        for px in range(size):
            bg_hits = 0
            moon_hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) * step
                    y = py + (sy + 0.5) * step
                    if in_rounded_rect(x, y, size, radius):
                        bg_hits += 1
                        if in_moon(x, y, size):
                            moon_hits += 1

            bg_cov = bg_hits / total
            if bg_cov <= 0:
                out += b"\x00\x00\x00\x00"
                continue

            moon_cov = moon_hits / total
            r = BG[0] * (1 - moon_cov) + MOON[0] * moon_cov
            g = BG[1] * (1 - moon_cov) + MOON[1] * moon_cov
            b = BG[2] * (1 - moon_cov) + MOON[2] * moon_cov

            # 背景本身带 alpha，颜色需按覆盖率还原为不透明像素值
            out += bytes((
                int(round(min(255, r / bg_cov))),
                int(round(min(255, g / bg_cov))),
                int(round(min(255, b / bg_cov))),
                int(round(bg_cov * 255)),
            ))

    return bytes(out)


def write_png(path, size, pixels):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw += pixels[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
           chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))

    with open(path, "wb") as fh:
        fh.write(png)


if __name__ == "__main__":
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    target = os.path.join(here, "icons")
    os.makedirs(target, exist_ok=True)

    report = []
    for size in (16, 48, 128):
        path = os.path.join(target, "icon%d.png" % size)
        write_png(path, size, render(size))
        report.append("%s -> %d bytes" % (path, os.path.getsize(path)))

    with open(os.path.join(here, "icons", "_report.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(report))
