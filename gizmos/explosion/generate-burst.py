"""Regenerate burst.webp with Python 3, ImageMagick (montage) and the repo’s Node sharp install."""

from math import cos, exp, pi, sin, sqrt
from pathlib import Path
from random import Random
from subprocess import run
from tempfile import TemporaryDirectory

SIZE = 192
GRID = 5
CENTER = SIZE / 2
OUTPUT = Path(__file__).with_name("burst.webp")
random = Random(741)
# Each plume has a short trailing billow and a quicker leading billow.
# Uneven bearings leave gaps for the spark trails to cross.
PLUMES = [
    (-2.61, 0.91, 0.61, 2.3),
    (-2.32, 1.15, 0.85, 1.2),
    (-1.96, 0.74, 1.00, 4.4),
    (-0.18, 1.20, 0.53, 1.1),
    (-0.39, 0.90, 0.87, 3.2),
    (0.03, 0.69, 1.10, 5.1),
    (1.92, 0.86, 0.67, 2.4),
    (1.56, 0.58, 0.87, 3.4),
]
SPARKS = [
    (angle, random.uniform(75, 106), random.uniform(0.32, 0.61))
    for angle in (-3.03, -2.85, -1.73, -1.36, -0.96, -0.83, 0.43, 0.67, 2.35, 2.79)
]


def clamp(value):
    return max(0, min(1, value))


def color(start, end, blend):
    return "#%02x%02x%02x" % tuple(
        round(a + (b - a) * blend) for a, b in zip(start, end)
    )


def lobe(x, y, radius, phase, fill, opacity, bearing=0, stretch=1):
    points = []
    for i in range(12):
        angle = i * pi / 6
        r = radius * (1 + 0.14 * sin(3 * angle + phase) + 0.11 * cos(5 * angle - phase))
        u, v = r * stretch * cos(angle), r * sin(angle)
        points.append((
            x + u * cos(bearing) - v * sin(bearing),
            y + u * sin(bearing) + v * cos(bearing),
        ))

    # Rounded corners at each sampled ridge keep the cloud organic when enlarged.
    midpoints = [
        ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        for a, b in zip(points, points[1:] + points[:1])
    ]
    path = "M %.2f %.2f" % midpoints[-1]
    for (px, py), (mx, my) in zip(points, midpoints):
        path += f" Q{px:.2f} {py:.2f} {mx:.2f} {my:.2f}"
    return f'<path d="{path} Z" fill="{fill}" fill-opacity="{opacity:.3f}"/>'


def frame(index):
    t = index / (GRID * GRID - 1)
    spread = 1 - exp(-5.6 * t)
    fade = clamp((1 - t) / 0.63) ** 1.2
    heat = clamp(1 - t / 0.46)
    body = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}">']
    if index == GRID * GRID - 1:
        return body[0] + "</svg>"

    ring = clamp(1 - t / 0.36) * clamp(t * 25)
    body.append(
        f'<circle cx="{CENTER}" cy="{CENTER}" r="{12 + 76 * spread:.2f}" '
        f'fill="none" stroke="#fbb259" stroke-opacity="{ring * 0.68:.3f}" '
        f'stroke-width="{1 + ring * 2:.2f}"/>'
    )
    for angle, speed, life in SPARKS:
        alpha = clamp(1 - t / life) * clamp(t * 28)
        if not alpha:
            continue
        travel = 23 + (speed - 23) * (1 - exp(-6.3 * t))
        x = CENTER + travel * cos(angle)
        y = CENTER + travel * sin(angle) + 24 * t * t
        length = 6 + 20 * alpha
        body.append(
            f'<path d="M{x:.2f} {y:.2f} l{-cos(angle) * length:.2f} {-sin(angle) * length:.2f}" '
            f'stroke="#b2572f" stroke-opacity="{alpha:.3f}" stroke-linecap="round" '
            f'stroke-width="{1 + alpha * 1.6:.2f}"/>'
        )
        body.append(
            f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{0.8 + alpha:.2f}" '
            f'fill="#ffcf71" opacity="{alpha:.3f}"/>'
        )

    for angle, reach, size, phase in PLUMES:
        bearing = angle + 0.45 * t
        travel = 3 + 48 * spread * reach
        x = CENTER + cos(bearing) * travel
        y = CENTER + sin(bearing) * travel - 11 * t
        radius = (4 + (13 + 6 * sin(pi * t)) * sqrt(spread)) * size
        outer = color((65, 49, 44), (135, 57, 36), heat)
        middle = color((112, 79, 59), (204, 87, 36), heat)
        edge = color((150, 104, 67), (246, 140, 46), heat)
        stretch = 1.38 - 0.42 * t
        # Fade each billow as a composite so its internal shading stays solid.
        body.extend([
            f'<g opacity="{fade * (0.8 + 0.2 * heat):.3f}">',
            lobe(x, y, radius, phase + t, outer, 1, bearing, stretch),
            lobe(x - 1, y - 2, radius * 0.79, phase + t, middle, 1, bearing, stretch),
            lobe(x - 3, y - 5, radius * 0.48, phase + 0.8, edge, 0.82, bearing, stretch),
            "</g>",
        ])

    if heat > 0:
        flash = clamp(heat * 2.8)
        radius = 6 + 24 * (1 - exp(-22 * t)) * heat
        body.append(f'<g opacity="{flash:.3f}">')
        body.append(lobe(CENTER - 2, CENTER, radius * 1.24, 2.2, "#e47125", 1, -0.42, 1.38))
        body.append(lobe(CENTER + 2, CENTER - 2, radius, 2.2, "#ffc348", 1, -0.42, 1.45))
        body.append(lobe(CENTER - 3, CENTER - 4, radius * 0.74, 1.1, "#fff0af", 1, -0.59, 1.41))
        body.append(lobe(CENTER - 5, CENTER - 5, radius * 0.47, 1.9, "#fff9db", 1, -0.59, 1.36))
        body.append("</g>")
    return "".join(body) + "</svg>"


def main():
    with TemporaryDirectory() as directory:
        frames = []
        for index in range(GRID * GRID):
            svg = Path(directory) / f"{index:02}.svg"
            png = svg.with_suffix(".png")
            svg.write_text(frame(index), encoding="utf-8")
            frames.append(str(png))
        # Sharp's SVG rasterizer preserves per-layer transparency.
        run(
            ["node", "-e", r"""
            const sharp = require('sharp');
            Promise.all(process.argv.slice(2).map(path =>
              sharp(path.replace(/\.png$/, '.svg'), {density: 144})
                .resize(Number(process.argv[1]), Number(process.argv[1]))
                .png()
                .toFile(path)
            )).catch(error => { console.error(error); process.exitCode = 1; });
            """, str(SIZE), *frames],
            cwd=Path(__file__).resolve().parents[2],
            check=True,
        )
        run(
            ["montage", *frames, "-tile", f"{GRID}x{GRID}", "-geometry",
             f"{SIZE}x{SIZE}+0+0", "-background", "none", "-quality", "86", str(OUTPUT)],
            check=True,
        )


if __name__ == "__main__":
    main()
