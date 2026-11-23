"""Generate the OCR fixture set: images plus exact ground truth.

Every image is rendered from text we write here with OFL / system fonts, so the
set is legally clean. Each fixture gets `<name>.gt.json` (format
`ocr-gt/1`): every word with its quadrilateral
(four corners, clockwise from the top-left of the upright word) and its
axis-aligned box, both in pixels of the final image, after every geometric
degradation (rotation, perspective, downscale) has been applied to the points.

Run: python generate.py [out_dir]   (deterministic: fixed seeds; needs numpy,
Pillow, DejaVu in /usr/share/fonts and, in fonts/ beside this file, the OFL
fonts Caveat, Cinzel, EB Garamond, MedievalSharp and Uncial Antiqua from
Google Fonts). The repository keeps six of its fourteen images
(e2e/tests/text-accuracy.spec.ts), each ground truth trimmed to the fields
the tests read.
"""

from __future__ import annotations

import io
import json
import math
import random
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
FONTS = HERE / "fonts"
SYS = Path("/usr/share/fonts/truetype")
FONT_FILES = {
    "sans": SYS / "dejavu/DejaVuSans.ttf",
    "sans_bold": SYS / "dejavu/DejaVuSans-Bold.ttf",
    "serif": SYS / "liberation/LiberationSerif-Regular.ttf",
    "serif_bold": SYS / "liberation/LiberationSerif-Bold.ttf",
    "mono": SYS / "dejavu/DejaVuSansMono.ttf",
    "garamond": FONTS / "EBGaramond[wght].ttf",
    "garamond_italic": FONTS / "EBGaramond-Italic[wght].ttf",
    "cinzel": FONTS / "Cinzel[wght].ttf",
    "medieval": FONTS / "MedievalSharp.ttf",
    "uncial": FONTS / "UncialAntiqua-Regular.ttf",
    "hand": FONTS / "Caveat[wght].ttf",
}
_font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    key = (name, size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(str(FONT_FILES[name]), size)
    return _font_cache[key]


@dataclass
class Word:
    text: str
    line: int
    quad: list[list[float]]
    angle: float
    curved: bool = False
    searchable: bool = False


@dataclass
class Canvas:
    image: Image.Image
    words: list[Word] = field(default_factory=list)
    lines: list[dict] = field(default_factory=list)

    def text(
        self,
        xy: tuple[float, float],
        text: str,
        *,
        face: str,
        size: int,
        fill=(20, 20, 20),
        angle: float = 0.0,
        searchable: bool = False,
    ) -> float:
        """Draw one line with its baseline-left at xy, rotated `angle` degrees
        counter-clockwise about that point. Returns the advance width."""
        f = font(face, size)
        line_id = len(self.lines)
        word_ids = []
        ascent, descent = f.getmetrics()
        pad = size
        width = f.getlength(text)
        tile = Image.new("RGBA", (int(width + 2 * pad), ascent + descent + 2 * pad), (0, 0, 0, 0))
        origin = (pad, pad + ascent)
        ImageDraw.Draw(tile).text(origin, text, font=f, fill=fill, anchor="ls")
        rad = math.radians(angle)
        cos, sin = math.cos(rad), math.sin(rad)

        def to_image(px: float, py: float) -> list[float]:
            dx, dy = px - origin[0], py - origin[1]
            # counter-clockwise on screen (y down)
            return [xy[0] + dx * cos + dy * sin, xy[1] - dx * sin + dy * cos]

        start = 0
        for token in text.split(" "):
            if token:
                left, top, right, bottom = f.getbbox(token, anchor="ls")
                off = f.getlength(text[:start])
                x0, x1 = origin[0] + off + left, origin[0] + off + right
                y0, y1 = origin[1] + top, origin[1] + bottom
                quad = [to_image(x0, y0), to_image(x1, y0), to_image(x1, y1), to_image(x0, y1)]
                word_ids.append(len(self.words))
                self.words.append(Word(token, line_id, quad, angle, searchable=searchable))
            start += len(token) + 1
        self.lines.append({"id": line_id, "text": text, "words": word_ids})
        self._composite(tile, origin, xy, angle)
        return width

    def _composite(self, tile, origin, xy, angle):
        if angle == 0:
            self.image.alpha_composite(tile, (int(round(xy[0] - origin[0])), int(round(xy[1] - origin[1]))))
            return
        rot = tile.rotate(angle, resample=Image.BICUBIC, expand=True)
        # where `origin` lands inside the expanded tile (rotated about its centre)
        w, h = tile.size
        rad = math.radians(angle)
        cos, sin = math.cos(rad), math.sin(rad)
        rx, ry = origin[0] - w / 2, origin[1] - h / 2
        ox = rot.width / 2 + rx * cos + ry * sin
        oy = rot.height / 2 - rx * sin + ry * cos
        dx, dy = int(round(xy[0] - ox)), int(round(xy[1] - oy))
        self._paste(rot, dx, dy)

    def _paste(self, tile, dx, dy):
        W, H = self.image.size
        x0, y0 = max(dx, 0), max(dy, 0)
        x1, y1 = min(dx + tile.width, W), min(dy + tile.height, H)
        if x1 <= x0 or y1 <= y0:
            return
        crop = tile.crop((x0 - dx, y0 - dy, x1 - dx, y1 - dy))
        self.image.alpha_composite(crop, (x0, y0))

    def curved_text(self, center, radius, start_deg, text, *, face, size, fill, searchable=True):
        """Text along a circular arc (counter-clockwise from start_deg, letters upright
        to the arc's outside). One line; each word's quad is the min-area rectangle of
        its letters."""
        from shapely.geometry import MultiPoint

        f = font(face, size)
        line_id = len(self.lines)
        word_ids = []
        theta = math.radians(start_deg)
        tokens: list[list[list[float]]] = [[]]
        for ch in text:
            adv = f.getlength(ch)
            mid = theta - (adv / 2) / radius
            px = center[0] + radius * math.cos(mid)
            py = center[1] - radius * math.sin(mid)
            tangent_deg = math.degrees(mid) - 90
            if ch == " ":
                tokens.append([])
            else:
                sub = Canvas(Image.new("RGBA", (1, 1)))
                left, top, right, bottom = f.getbbox(ch, anchor="ls")
                bx = px - (adv / 2) * math.cos(math.radians(tangent_deg))
                by = py + (adv / 2) * math.sin(math.radians(tangent_deg))
                self._draw_char(ch, f, fill, (bx, by), tangent_deg)
                rad = math.radians(tangent_deg)
                c, s = math.cos(rad), math.sin(rad)
                for qx, qy in [(left, top), (right, top), (right, bottom), (left, bottom)]:
                    tokens[-1].append([bx + qx * c + qy * s, by - qx * s + qy * c])
                del sub
            theta -= adv / radius
        texts = text.split(" ")
        for token, pts in zip(texts, tokens):
            if not pts:
                continue
            rect = MultiPoint(pts).minimum_rotated_rectangle
            quad = [list(p) for p in list(rect.exterior.coords)[:4]]
            word_ids.append(len(self.words))
            self.words.append(Word(token, line_id, order_quad(quad), 0.0, curved=True, searchable=searchable))
        self.lines.append({"id": line_id, "text": text, "words": word_ids, "curved": True})

    def _draw_char(self, ch, f, fill, xy, angle):
        size = f.size
        ascent, descent = f.getmetrics()
        pad = size
        tile = Image.new("RGBA", (int(f.getlength(ch) + 2 * pad), ascent + descent + 2 * pad), (0, 0, 0, 0))
        origin = (pad, pad + ascent)
        ImageDraw.Draw(tile).text(origin, ch, font=f, fill=fill, anchor="ls")
        self._composite(tile, origin, xy, angle)


def order_quad(quad):
    """Order four points clockwise starting from the one nearest the top-left."""
    cx = sum(p[0] for p in quad) / 4
    cy = sum(p[1] for p in quad) / 4
    pts = sorted(quad, key=lambda p: math.atan2(p[1] - cy, p[0] - cx))
    start = min(range(4), key=lambda i: pts[i][0] + pts[i][1])
    return pts[start:] + pts[:start]


# ---------------------------------------------------------------- degradations


def map_points(words, fn):
    for w in words:
        w.quad = [list(fn(x, y)) for x, y in w.quad]


def rotate_page(cv: Canvas, deg: float):
    W, H = cv.image.size
    cx, cy = W / 2, H / 2
    cv.image = cv.image.rotate(deg, resample=Image.BICUBIC, center=(cx, cy), fillcolor=(235, 233, 228, 255))
    rad = math.radians(deg)
    c, s = math.cos(rad), math.sin(rad)
    map_points(cv.words, lambda x, y: (cx + (x - cx) * c + (y - cy) * s, cy - (x - cx) * s + (y - cy) * c))
    for w in cv.words:
        w.angle += deg


def homography(src, dst):
    a = []
    for (x, y), (u, v) in zip(src, dst):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    b = [c for p in dst for c in p]
    h = np.linalg.solve(np.array(a, float), np.array(b, float))
    return np.append(h, 1).reshape(3, 3)


def perspective(cv: Canvas, dst_corners, out_size):
    W, H = cv.image.size
    src = [(0, 0), (W, 0), (W, H), (0, H)]
    fwd = homography(src, dst_corners)
    inv = np.linalg.inv(fwd)
    inv = inv / inv[2, 2]
    cv.image = cv.image.transform(out_size, Image.PERSPECTIVE, tuple(inv.flatten()[:8]), Image.BICUBIC, fillcolor=(70, 62, 55, 255))

    def fn(x, y):
        v = fwd @ np.array([x, y, 1.0])
        return float(v[0] / v[2]), float(v[1] / v[2])

    map_points(cv.words, fn)


def scale(cv: Canvas, factor: float):
    W, H = cv.image.size
    cv.image = cv.image.resize((round(W * factor), round(H * factor)), Image.LANCZOS)
    map_points(cv.words, lambda x, y: (x * factor, y * factor))


def lighting(cv: Canvas, *, rng, strength=0.35, shadow=False):
    W, H = cv.image.size
    arr = np.asarray(cv.image.convert("RGB"), dtype=np.float32)
    yy, xx = np.mgrid[0:H, 0:W]
    gx, gy = rng.uniform(-1, 1), rng.uniform(-1, 1)
    grad = 1 - strength * (0.5 + 0.5 * ((xx / W - 0.5) * gx + (yy / H - 0.5) * gy))
    if shadow:
        # a soft diagonal shadow of a hand/phone across one corner
        d = (xx / W) * 0.8 + (yy / H) * 0.6
        grad = grad * (1 - 0.45 * np.clip((d - 0.95) * 4, 0, 1))
    arr = arr * grad[..., None]
    cv.image = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).convert("RGBA")


def noise(cv: Canvas, *, rng, sigma=6.0):
    arr = np.asarray(cv.image.convert("RGB"), dtype=np.float32)
    arr += rng.normal(0, sigma, arr.shape[:2])[..., None]
    cv.image = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).convert("RGBA")


def blur(cv: Canvas, r=0.8):
    cv.image = cv.image.filter(ImageFilter.GaussianBlur(r))


def jpeg_roundtrip(img: Image.Image, quality: int) -> bytes:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=quality)
    return buf.getvalue()


# ---------------------------------------------------------------- content

SHEET = {
    "en": {
        "title": "CHARACTER SHEET",
        "fields": [
            ("Name:", "Elowen Thistlewood", True),
            ("Player:", "Martin Hale", True),
            ("Class:", "Ranger", False),
            ("Race:", "Half-elf", False),
            ("Level:", "7", False),
            ("Alignment:", "Neutral Good", False),
            ("Homeland:", "Ravenhold", True),
            ("Deity:", "Sylvaris", True),
        ],
        "stats": [("STR", "12"), ("DEX", "18"), ("CON", "14"), ("INT", "11"), ("WIS", "16"), ("CHA", "10")],
        "equip_label": "Equipment:",
        "equip": ["Longbow of Greywater, 40 arrows", "Elven cloak, rope (50 ft)", "Letter sealed by Lord Ashcombe"],
        "notes_label": "Notes:",
        "notes": ["Owes a debt to Brannoc the smith.", "Seeks her brother Corwin in Thornwick."],
        "names": ["Brannoc", "Corwin", "Thornwick", "Ashcombe", "Greywater"],
    },
    "pl": {
        "title": "KARTA POSTACI",
        "fields": [
            ("Imię:", "Zbigniew Łęczycki", True),
            ("Gracz:", "Małgorzata Ślązak", True),
            ("Klasa:", "Łowca", False),
            ("Rasa:", "Półelf", False),
            ("Poziom:", "7", False),
            ("Charakter:", "Praworządny dobry", False),
            ("Ojczyzna:", "Ząbkowice Mroczne", True),
            ("Bóstwo:", "Świętobór", True),
        ],
        "stats": [("SIŁ", "12"), ("ZRĘ", "18"), ("KON", "14"), ("INT", "11"), ("MDR", "16"), ("CHA", "10")],
        "equip_label": "Ekwipunek:",
        "equip": ["Łuk z Grodu Żółwia, 40 strzał", "Płaszcz elfów, lina (15 m)", "List zapieczętowany przez księcia Jaźwińskiego"],
        "notes_label": "Notatki:",
        "notes": ["Jest winien pieniądze kowalowi Grzegorzowi.", "Szuka brata Mścisława w Kraśniku Dolnym."],
        "names": ["Żółwia", "Jaźwińskiego", "Grzegorzowi", "Mścisława", "Kraśniku", "Dolnym"],
    },
}

MAP = {
    "en": [
        # text, face, size, angle, searchable
        ("Ravenhold", "cinzel", 46, 0),
        ("Thornwick", "garamond_italic", 40, 15),
        ("Port Elderwyn", "medieval", 38, 0),
        ("Greywater Bay", "garamond_italic", 44, -30),
        ("Silverfen Marsh", "uncial", 34, 45),
        ("River Wyrm", "garamond_italic", 34, 90),
        ("Kingdom of Aldmere", "cinzel", 60, 0),
        ("Old Mill", "serif", 26, 0),
        ("Barrow of Kings", "medieval", 30, -15),
    ],
    "pl": [
        ("Gród Żółwia", "cinzel", 46, 0),
        ("Kraśnik Dolny", "garamond_italic", 40, 15),
        ("Przystań Wędrowców", "medieval", 36, 0),
        ("Zatoka Śledziowa", "garamond_italic", 44, -30),
        ("Bagna Źródlane", "uncial", 34, 45),
        ("Rzeka Wąwozowa", "garamond_italic", 34, 90),
        ("Królestwo Łęgów", "cinzel", 60, 0),
        ("Stary Młyn", "serif", 26, 0),
        ("Kurhan Książąt", "medieval", 30, -15),
    ],
}
MAP_CURVED = {"en": "Dragonspine Mountains", "pl": "Góry Smocze Ćmy"}

RULES = {
    "en": [
        ("h", "Combat"),
        ("p", "At the start of each round every combatant rolls initiative with a twenty-sided die and adds their Dexterity modifier. Ties are broken by the higher Dexterity score; if still tied, the players decide among themselves."),
        ("p", "On your turn you may move up to your speed and take one action. Moving through difficult terrain, such as the Silverfen Marsh or rubble, costs two feet of movement for every foot travelled."),
        ("h", "Attacks"),
        ("p", "To attack, roll a twenty-sided die and add your attack bonus. If the total equals or exceeds the target's Armour Class, the attack hits and you roll damage. A natural twenty is a critical hit: roll the damage dice twice."),
        ("p", "Ranged attacks made within five feet of a hostile creature are rolled with disadvantage. Cover grants a bonus of two or five to the defender's Armour Class."),
        ("h", "Resting"),
        ("p", "A short rest lasts one hour. A long rest lasts eight hours and restores all lost hit points. Characters camping in the Whispering Woods must keep watch, because wolves from Ravenhold hunt at night."),
        ("h", "Conditions"),
        ("p", "A frightened creature cannot move closer to the source of its fear. A poisoned creature has disadvantage on attack rolls and ability checks. A stunned creature fails Strength and Dexterity saving throws."),
        ("p", "Exhaustion is measured in six levels. Each level imposes a cumulative penalty, and a creature that reaches the sixth level dies. Finishing a long rest removes one level of exhaustion."),
    ],
    "pl": [
        ("h", "Walka"),
        ("p", "Na początku każdej rundy wszyscy uczestnicy walki rzucają kością dwudziestościenną na inicjatywę i dodają modyfikator Zręczności. Remis rozstrzyga wyższa Zręczność; jeśli nadal jest remis, gracze ustalają kolejność między sobą."),
        ("p", "W swojej turze możesz przemieścić się o swoją szybkość i wykonać jedną akcję. Ruch przez trudny teren, taki jak Bagna Źródlane czy gruzowisko, kosztuje dwa metry ruchu za każdy przebyty metr."),
        ("h", "Ataki"),
        ("p", "Aby zaatakować, rzuć kością dwudziestościenną i dodaj premię do ataku. Jeśli wynik jest równy Klasie Pancerza celu lub wyższy, atak trafia i rzucasz na obrażenia. Naturalna dwudziestka to trafienie krytyczne: rzuć kośćmi obrażeń dwukrotnie."),
        ("p", "Ataki dystansowe wykonane w odległości półtora metra od wrogiej istoty rzuca się z utrudnieniem. Osłona zapewnia obrońcy premię dwóch lub pięciu do Klasy Pancerza."),
        ("h", "Odpoczynek"),
        ("p", "Krótki odpoczynek trwa godzinę. Długi odpoczynek trwa osiem godzin i przywraca wszystkie utracone punkty wytrzymałości. Postacie obozujące w Puszczy Szeptów muszą trzymać wartę, bo wilki z Grodu Żółwia polują nocą."),
        ("h", "Stany"),
        ("p", "Przestraszona istota nie może zbliżyć się do źródła strachu. Zatruta istota ma utrudnienie w rzutach ataku i testach cech. Ogłuszona istota automatycznie oblewa rzuty obronne na Siłę i Zręczność."),
        ("p", "Wyczerpanie ma sześć poziomów. Każdy poziom nakłada narastającą karę, a istota, która osiągnie szósty poziom, ginie. Ukończenie długiego odpoczynku usuwa jeden poziom wyczerpania."),
    ],
}
RULES_NAMES = {"en": ["Silverfen", "Marsh", "Whispering", "Woods", "Ravenhold"], "pl": ["Bagna", "Źródlane", "Puszczy", "Szeptów", "Grodu", "Żółwia"]}

HANDOUT = {
    "en": ["My dear Aldric,", "The road to Thornwick is no longer safe.", "Brother Corwin was taken near the", "Barrow of Kings three nights ago.", "Bring the silver key to Port Elderwyn", "and ask for Mistress Odelyn.", "Burn this letter.", "— Seraphine"],
    "pl": ["Drogi Bolesławie,", "Droga do Kraśnika Dolnego nie jest już", "bezpieczna. Brat Mścisław zaginął przy", "Kurhanie Książąt trzy noce temu.", "Zanieś srebrny klucz do Przystani", "Wędrowców i zapytaj o panią Jadwigę.", "Spal ten list.", "— Bożena Źdźbło"],
}
HANDOUT_NAMES = {"en": ["Aldric", "Thornwick", "Corwin", "Barrow", "Kings", "Elderwyn", "Odelyn", "Seraphine"], "pl": ["Bolesławie", "Kraśnika", "Dolnego", "Mścisław", "Kurhanie", "Książąt", "Przystani", "Wędrowców", "Jadwigę", "Bożena", "Źdźbło"]}

HAND = {
    "en": ["Session 12 notes", "Met Odelyn at the Old Mill", "She knows where Corwin is held", "Ask Brannoc about the silver key", "Next: travel to Greywater Bay"],
    "pl": ["Notatki z sesji 12", "Spotkaliśmy Jadwigę w Starym Młynie", "Wie, gdzie więżą Mścisława", "Zapytać Grzegorza o srebrny klucz", "Dalej: podróż do Zatoki Śledziowej"],
}
HAND_NAMES = {"en": ["Odelyn", "Corwin", "Brannoc", "Greywater"], "pl": ["Jadwigę", "Mścisława", "Grzegorza", "Śledziowej", "Młynie"]}


# ---------------------------------------------------------------- scenes


def sheet(lang: str, k: float = 1.0) -> Canvas:
    """A4 form at 150 dpi (k=1 → 1240×1754)."""
    d = SHEET[lang]
    W, H = round(1240 * k), round(1754 * k)
    cv = Canvas(Image.new("RGBA", (W, H), (252, 251, 247, 255)))
    dr = ImageDraw.Draw(cv.image)
    s = lambda v: v * k  # noqa: E731
    dr.rectangle([s(60), s(60), W - s(60), H - s(60)], outline=(40, 40, 40), width=max(1, round(3 * k)))
    cv.text((s(100), s(150)), d["title"], face="serif_bold", size=round(56 * k))
    ink = (25, 45, 120)
    y = 250
    for i, (label, value, srch) in enumerate(d["fields"]):
        col = i % 2
        x = 100 + col * 540
        if col == 0 and i:
            y += 70
        lw = cv.text((s(x), s(y)), label, face="sans_bold", size=round(22 * k))
        dr.line([s(x) + lw + s(10), s(y + 6), s(x + 500), s(y + 6)], fill=(90, 90, 90), width=max(1, round(k)))
        cv.text((s(x) + lw + s(18), s(y)), value, face="serif", size=round(28 * k), fill=ink, searchable=srch)
    y += 110
    for i, (stat, val) in enumerate(d["stats"]):
        x = 100 + i * 175
        dr.rectangle([s(x), s(y), s(x + 140), s(y + 130)], outline=(40, 40, 40), width=max(1, round(2 * k)))
        cv.text((s(x + 40), s(y + 40)), stat, face="sans_bold", size=round(24 * k))
        cv.text((s(x + 50), s(y + 105)), val, face="serif", size=round(40 * k), fill=ink)
    y += 220
    cv.text((s(100), s(y)), d["equip_label"], face="sans_bold", size=round(24 * k))
    for line in d["equip"]:
        y += 52
        dr.line([s(100), s(y + 8), s(1140), s(y + 8)], fill=(170, 170, 170), width=1)
        cv.text((s(120), s(y)), line, face="serif", size=round(26 * k), fill=ink)
    y += 100
    cv.text((s(100), s(y)), d["notes_label"], face="sans_bold", size=round(24 * k))
    for line in d["notes"]:
        y += 52
        dr.line([s(100), s(y + 8), s(1140), s(y + 8)], fill=(170, 170, 170), width=1)
        cv.text((s(120), s(y)), line, face="serif", size=round(26 * k), fill=ink)
    mark_names(cv, d["names"])
    return cv


def mark_names(cv: Canvas, names):
    strip = lambda t: t.strip(".,:;()—")  # noqa: E731
    for w in cv.words:
        if strip(w.text) in names:
            w.searchable = True


def parchment(W, H, rng) -> Image.Image:
    base = np.zeros((H, W), np.float32)
    for octave, amp in [(8, 1.0), (32, 0.5), (128, 0.25)]:
        small = rng.random((max(2, H * octave // W), octave)).astype(np.float32)
        layer = np.asarray(Image.fromarray((small * 255).astype(np.uint8)).resize((W, H), Image.BICUBIC), np.float32) / 255
        base += amp * layer
    base = base / base.max()
    r = 214 + 30 * base
    g = 196 + 28 * base
    b = 150 + 25 * base
    return Image.fromarray(np.dstack([r, g, b]).clip(0, 255).astype(np.uint8)).convert("RGBA")


def fantasy_map(lang: str) -> Canvas:
    rng = np.random.default_rng(7)
    rnd = random.Random(7)
    W, H = 2048, 1536
    cv = Canvas(parchment(W, H, rng))
    dr = ImageDraw.Draw(cv.image)
    # coastline, river, hills, forest dots, roads: clutter that looks like map art
    coast = [(0, 1100)]
    for x in range(0, W + 64, 64):
        coast.append((x, 1100 + 80 * math.sin(x / 210) + rnd.uniform(-25, 25)))
    coast.append((W, H))
    coast.append((0, H))
    dr.polygon(coast, fill=(150, 175, 185, 255), outline=(70, 60, 50))
    river = [(1500 + 30 * math.sin(y / 90), y) for y in range(0, 1100, 20)]
    dr.line(river, fill=(110, 140, 160), width=9)
    for _ in range(70):
        x, y = rnd.uniform(80, 1900), rnd.uniform(80, 1000)
        sz = rnd.uniform(16, 34)
        dr.polygon([(x - sz, y + sz * 0.7), (x, y - sz), (x + sz, y + sz * 0.7)], outline=(90, 70, 50), width=2)
    for _ in range(260):
        x, y = rnd.uniform(200, 900), rnd.uniform(500, 1000)
        dr.ellipse([x - 6, y - 6, x + 6, y + 6], outline=(60, 90, 50), width=2)
    road = [(200, 300), (600, 420), (900, 380), (1300, 600), (1700, 700)]
    dr.line(road, fill=(130, 100, 70), width=3)
    for x, y in road:
        dr.ellipse([x - 9, y - 9, x + 9, y + 9], fill=(120, 30, 30))
    ink = (60, 38, 20)
    positions = [(170, 290), (560, 470), (1180, 660), (980, 1300), (400, 900), (1560, 420), (620, 140), (880, 360), (1650, 900)]
    for (text, face, size, angle), (x, y) in zip(MAP[lang], positions):
        cv.text((x, y), text, face=face, size=size, fill=ink if face != "cinzel" or size < 50 else (120, 40, 30), angle=angle, searchable=True)
    cv.curved_text((1300, 1150), 520, 150, MAP_CURVED[lang], face="cinzel", size=40, fill=(80, 50, 30))
    return cv


def wrap(text, f, width):
    lines, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if f.getlength(t) > width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = t
    if cur:
        lines.append(cur)
    return lines


def rules(lang: str) -> Canvas:
    W, H = 1600, 1000
    cv = Canvas(Image.new("RGBA", (W, H), (255, 255, 255, 255)))
    dr = ImageDraw.Draw(cv.image)
    dr.rectangle([0, 0, W, 44], fill=(40, 44, 52))
    cv.text((20, 30), "Rules Reference — Chapter 9" if lang == "en" else "Podręcznik zasad — Rozdział 9", face="sans", size=16, fill=(230, 230, 230))
    col_w, x0s = 700, [60, 840]
    col, y = 0, 90
    body = font("sans", 14)
    for kind, text in RULES[lang]:
        need = 34 if kind == "h" else 21 * len(wrap(text, body, col_w)) + 12
        if y + need > H - 30:
            col, y = col + 1, 90
        x = x0s[col]
        if kind == "h":
            cv.text((x, y + 10), text, face="sans_bold", size=19)
            y += 34
        else:
            for line in wrap(text, body, col_w):
                cv.text((x, y + 12), line, face="sans", size=14, fill=(30, 30, 30))
                y += 21
            y += 12
    mark_names(cv, RULES_NAMES[lang])
    return cv


def handout(lang: str) -> Canvas:
    W, H = 1400, 1000
    rng = np.random.default_rng(11)
    cv = Canvas(parchment(W, H, rng))
    y = 140
    for i, line in enumerate(HANDOUT[lang]):
        cv.text((120, y), line, face="garamond_italic" if i in (0, 7) else "garamond", size=44, fill=(45, 30, 20))
        y += 96 if i in (0, 5, 6) else 78
    mark_names(cv, HANDOUT_NAMES[lang])
    # photographed: page lies on a dark table, skewed, then phone resolution
    perspective(cv, [(210, 150), (1430, 90), (1520, 1110), (130, 1010)], (1600, 1200))
    lighting(cv, rng=rng, strength=0.45, shadow=True)
    noise(cv, rng=rng, sigma=5)
    blur(cv, 0.7)
    return cv


def handwritten(lang: str) -> Canvas:
    W, H = 1400, 900
    rnd = random.Random(5)
    cv = Canvas(Image.new("RGBA", (W, H), (250, 248, 238, 255)))
    dr = ImageDraw.Draw(cv.image)
    for yy in range(140, H, 70):
        dr.line([(60, yy + 8), (W - 60, yy + 8)], fill=(170, 190, 220), width=2)
    y = 140
    for i, line in enumerate(HAND[lang]):
        cv.text((100 + rnd.uniform(-10, 20), y), line, face="hand", size=62 if i == 0 else 50, fill=(30, 40, 110), angle=rnd.uniform(-2.5, 2.5))
        y += 140 if i == 0 else 140
    mark_names(cv, HAND_NAMES[lang])
    return cv


def small_card() -> Canvas:
    W, H = 360, 200
    cv = Canvas(Image.new("RGBA", (W, H), (245, 240, 228, 255)))
    dr = ImageDraw.Draw(cv.image)
    dr.rectangle([4, 4, W - 5, H - 5], outline=(90, 60, 40), width=3)
    cv.text((18, 52), "Jadwiga Żmudzka", face="serif_bold", size=26, searchable=True)
    cv.text((18, 92), "Elfka, łuczniczka", face="serif", size=18)
    cv.text((18, 128), "KP 15  PW 22  Szybkość 9 m", face="sans", size=14)
    cv.text((18, 160), "Strażniczka Bagien Źródlanych", face="serif", size=15)
    mark_names(cv, ["Jadwiga", "Żmudzka", "Bagien", "Źródlanych"])
    return cv


def scanned(cv: Canvas, *, seed: int, deg: float, factor: float) -> Canvas:
    rng = np.random.default_rng(seed)
    rotate_page(cv, deg)
    lighting(cv, rng=rng, strength=0.3)
    blur(cv, 1.1)
    noise(cv, rng=rng, sigma=7)
    scale(cv, factor)
    return cv


# ---------------------------------------------------------------- output


def aabb(quad):
    xs, ys = [p[0] for p in quad], [p[1] for p in quad]
    return [round(min(xs), 1), round(min(ys), 1), round(max(xs), 1), round(max(ys), 1)]


def save(cv: Canvas, out: Path, name: str, *, langs, category, variant, notes, fmt="png", quality=90):
    out.mkdir(parents=True, exist_ok=True)
    if fmt == "jpg":
        data = jpeg_roundtrip(cv.image, quality)
        (out / f"{name}.jpg").write_bytes(data)
        filename = f"{name}.jpg"
    else:
        filename = f"{name}.png"
        cv.image.convert("RGB").save(out / filename, optimize=True)
    W, H = cv.image.size
    words = [
        {
            "id": i,
            "text": w.text,
            "line": w.line,
            "quad": [[round(x, 1), round(y, 1)] for x, y in w.quad],
            "bbox": aabb(w.quad),
            "angle": round(w.angle, 2),
            "curved": w.curved,
            "searchable": w.searchable,
        }
        for i, w in enumerate(cv.words)
    ]
    searchable = sorted({w["text"].strip(".,:;()—") for w in words if w["searchable"] and len(w["text"].strip(".,:;()—")) >= 3})
    gt = {
        "format": "ocr-gt/1",
        "image": filename,
        "width": W,
        "height": H,
        "languages": langs,
        "category": category,
        "variant": variant,
        "notes": notes,
        "text": "\n".join(l["text"] for l in cv.lines),
        "lines": cv.lines,
        "words": words,
        "searchable": searchable,
    }
    (out / f"{name}.gt.json").write_text(json.dumps(gt, ensure_ascii=False, indent=1))
    print(f"{filename:28s} {W}x{H} words={len(words)} searchable={len(searchable)}")


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "fixtures"
    for lang in ("en", "pl"):
        L = ["eng"] if lang == "en" else ["pol"]
        save(sheet(lang), out, f"sheet_{lang}_clean", langs=L, category="sheet", variant="clean", notes="A4 form at 150 dpi, printed labels, typed values")
        save(scanned(sheet(lang), seed=3, deg=2.2 if lang == "en" else -1.6, factor=0.8), out, f"sheet_{lang}_scan", langs=L, category="sheet", variant="scan",
             notes="rotated ~2°, blur, noise, uneven light, 0.8× (120 dpi), JPEG q55", fmt="jpg", quality=55)
        save(fantasy_map(lang), out, f"map_{lang}", langs=L, category="map", variant="clean", notes="parchment texture, decorative fonts, labels at 0/±15/-30/45/90°, one curved label", fmt="jpg", quality=88)
        save(rules(lang), out, f"rules_{lang}", langs=L, category="rules", variant="screenshot", notes="dense 14 px sans, two columns, 1600×1000 screenshot")
        save(handout(lang), out, f"handout_{lang}_photo", langs=L, category="handout", variant="photo", notes="perspective skew, corner shadow, noise, JPEG q70", fmt="jpg", quality=70)
        save(handwritten(lang), out, f"hand_{lang}", langs=L, category="handwriting", variant="clean", notes="Caveat handwriting-style font on ruled paper; expected to be hard")
    save(sheet("pl", k=4096 / 1754), out, "large_sheet_pl", langs=["pol"], category="sheet", variant="large", notes="2896×4096 (the app's upload cap), ~350 dpi", fmt="jpg", quality=85)
    save(small_card(), out, "small_card_pl", langs=["pol"], category="token", variant="small", notes="360×200 NPC card, 14–26 px text")


if __name__ == "__main__":
    main()
