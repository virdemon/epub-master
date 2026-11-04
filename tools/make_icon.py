# -*- coding: utf-8 -*-
"""把 dist/icons/icon_*.png 打包成 Windows 用的多尺寸 .ico。

ICO 允许每帧直接放 PNG（Vista 以后都支持），所以不需要 BMP 转换。
"""
import os, struct, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, 'dist', 'icons')
OUT = os.path.join(ROOT, 'dist', 'icon.ico')
SIZES = [256, 128, 64, 48, 32, 16]


def main():
    frames = []
    for s in SIZES:
        p = os.path.join(ICON_DIR, f'icon_{s}.png')
        if not os.path.exists(p):
            raise SystemExit(f'缺少 {p}，先运行 node test/icon.js')
        with open(p, 'rb') as f:
            data = f.read()
        if data[:8] != b'\x89PNG\r\n\x1a\n':
            raise SystemExit(f'{p} 不是 PNG')
        w, h = struct.unpack('>II', data[16:24])
        frames.append((s, w, h, data))

    # ICONDIR
    header = struct.pack('<HHH', 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries, blobs = b'', b''
    for size, w, h, data in frames:
        dim = 0 if size >= 256 else size          # 256 在目录里写 0
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)

    with open(OUT, 'wb') as f:
        f.write(header + entries + blobs)
    print(f'已生成 {OUT}　{len(frames)} 帧　{os.path.getsize(OUT) / 1024:.1f} KB')

    # 回读校验
    with open(OUT, 'rb') as f:
        raw = f.read()
    rsv, typ, cnt = struct.unpack('<HHH', raw[:6])
    assert rsv == 0 and typ == 1 and cnt == len(frames), 'ICO 头不对'
    off = struct.unpack('<I', raw[6 + 16 * (len(frames) - 1) + 12:6 + 16 * len(frames)])[0]
    assert raw[off:off + 8] == b'\x89PNG\r\n\x1a\n', '最后一帧偏移不对'
    print('  回读校验通过：目录项', cnt, '个，偏移正确')


if __name__ == '__main__':
    main()
