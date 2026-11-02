"""Write a few simple binary STL files (a small gantry) for trying the app.

Usage: python tools/make_demo_stls.py [target_dir]
"""

import math
import struct
import sys
from pathlib import Path


def box(sx, sy, sz, ox=0.0, oy=0.0, oz=0.0):
    x0, x1, y0, y1, z0, z1 = ox - sx / 2, ox + sx / 2, oy - sy / 2, oy + sy / 2, oz, oz + sz
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
         (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    quads = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (3, 0, 4, 7)]
    tris = []
    for a, b, c, d in quads:
        tris += [(v[a], v[b], v[c]), (v[a], v[c], v[d])]
    return tris


def cylinder(r, h, n=48, oz=0.0):
    tris = []
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        p0, p1 = (r * math.cos(a0), r * math.sin(a0)), (r * math.cos(a1), r * math.sin(a1))
        b0, b1, t0, t1 = (*p0, oz), (*p1, oz), (*p0, oz + h), (*p1, oz + h)
        tris += [(b0, b1, t1), (b0, t1, t0), ((0, 0, oz), b1, b0), ((0, 0, oz + h), t0, t1)]
    return tris


def normal(t):
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = t
    ux, uy, uz, vx, vy, vz = bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az
    n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    length = math.sqrt(sum(c * c for c in n)) or 1.0
    return tuple(c / length for c in n)


def write_stl(path, tris):
    with open(path, "wb") as f:
        f.write(b"demo".ljust(80, b" "))
        f.write(struct.pack("<I", len(tris)))
        for t in tris:
            f.write(struct.pack("<3f", *normal(t)))
            for p in t:
                f.write(struct.pack("<3f", *p))
            f.write(b"\0\0")


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("demo-stl")
    out.mkdir(parents=True, exist_ok=True)
    # Machine bed with two side rails; MCS origin is at the centre of the bed top (z = 0 at 160 mm)
    write_stl(out / "bed.stl", box(800, 600, 40) + box(40, 600, 120, -380, 0, 40) + box(40, 600, 120, 380, 0, 40))
    # Bridge spanning the rails (moves along Y), origin at bridge centre
    write_stl(out / "bridge.stl", box(800, 80, 60, 0, 0, 0) + box(40, 80, 60, -380, 0, -60) + box(40, 80, 60, 380, 0, -60))
    # Carriage riding on the bridge (moves along X)
    write_stl(out / "carriage.stl", box(120, 120, 80, 0, -100, -20))
    # Z slide with spindle (moves along Z), tool tip at local origin
    write_stl(out / "spindle.stl", box(70, 70, 260, 0, 0, 40) + cylinder(12, 40, oz=0))
    # Rotary table (C axis)
    write_stl(out / "rotary-table.stl", cylinder(120, 30, oz=-30) + box(160, 20, 6, 0, 0, 0))
    print(f"demo STLs written to {out.resolve()}")


if __name__ == "__main__":
    main()
