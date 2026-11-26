// Run with Node from the repository after installing project dependencies.
import { readFile } from "node:fs/promises";
import sharp from "sharp";

const here = new URL("./", import.meta.url);
const source = new URL("../tarot/art/", here);
const manifest = JSON.parse(await readFile(new URL("gizmo.json", here), "utf8"));
// Crop centers on the original card as normalized x/y coordinates.
const centers = [
  [0.51, 0.275],
  [0.54, 0.295],
  [0.48, 0.265],
  [0.48, 0.28],
  [0.6, 0.28],
  [0.45, 0.255],
  [0.47, 0.29],
  [0.39, 0.331],
];
const cuts = await Promise.all(
  manifest.portraits.map(async (file, index) => {
    const image = sharp(await readFile(new URL(file, source)));
    const { width, height } = await image.metadata();
    const [x, y] = centers[index];
    const edge = Math.round(width * 0.58);
    const cut = await image
      .extract({
        left: Math.round(x * width - edge / 2),
        top: Math.round(y * height - edge / 2),
        width: edge,
        height: edge,
      })
      .resize(144)
      .webp({ quality: 91 })
      .toBuffer();
    await sharp(cut).toFile(new URL(file, here).pathname);
    return (await sharp(cut).png().toBuffer()).toString("base64");
  }),
);

const svg =
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="232" height="116" viewBox="0 0 232 116">
<defs>
<linearGradient id="iron" x2="0" y2="1"><stop stop-color="#403c35"/><stop offset="1" stop-color="#242725"/></linearGradient>
<clipPath id="crop"><rect x="0" y="0" width="56" height="54" rx="4"/></clipPath>
</defs>
<rect x="3" y="5" width="226" height="108" rx="10" fill="#171916"/>
<rect x="3" y="2" width="226" height="108" rx="9" fill="url(#iron)" stroke="#20201e" stroke-width="2"/>
<path d="M14 5h203" stroke="#837363" stroke-linecap="round"/>
<g transform="translate(19 15)">
<rect x="-2" y="-2" width="60" height="58" rx="5" fill="#ffda88"/>
<image href="data:image/png;base64,${cuts[1]}" width="56" height="56" clip-path="url(#crop)"/>
<rect y="62" width="56" height="19" rx="3" fill="#282520" stroke="#6c5940"/>
<text x="28" y="75" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="bold" fill="#f3e4c9">Ash</text>
</g>
<g transform="translate(91 15)">
<rect x="-2" y="-2" width="60" height="58" rx="5" fill="#78674a"/>
<image href="data:image/png;base64,${cuts[2]}" width="56" height="56" clip-path="url(#crop)"/>
<rect y="62" width="56" height="19" rx="3" fill="#282520" stroke="#6c5940"/>
<text x="28" y="75" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="bold" fill="#f3e4c9">Rowan</text>
</g>
<path d="M162 14v84" stroke="#665642"/>
<rect x="172" y="20" width="43" height="44" rx="5" fill="#705739" stroke="#a27c50"/>
<rect x="172" y="71" width="43" height="25" rx="5" fill="#302b24" stroke="#886a3e"/>
<path d="M184 42h18m-6-6 6 6-6 6m-8 35.5h11m-5.5-5.5v11" fill="none" stroke="#f2d5a0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);

await sharp(svg, { density: 144 })
  .webp({ quality: 92 })
  .toFile(new URL("preview.webp", here).pathname);
await sharp(svg).resize(80).webp({ quality: 90 }).toFile(new URL("thumbnail.webp", here).pathname);
