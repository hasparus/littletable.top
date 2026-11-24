import type { ReactNode } from "react";

import { chromium } from "@playwright/test";
// Run with Bun and Playwright Chromium installed:
// bun scripts/open-graph.tsx shared-board client/open-graph.png
// bun scripts/open-graph.tsx gallery /tmp/littletable-open-graph.html
import { readFile, writeFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";

const WIDTH = 1200;
const HEIGHT = 630;
const CORAL = "#f85a3c";
const INK = "#1c1917";
const PAPER = "#fff9ef";

function Logo({ size = 66, x, y }: { size?: number; x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${size / 120})`}>
      <rect fill={CORAL} height="112" rx="28" width="112" x="4" y="4" />
      <rect fill="#fff" height="64" rx="14" width="64" x="28" y="28" />
      <g fill={CORAL}>
        <circle cx="44" cy="44" r="7" />
        <circle cx="60" cy="60" r="7" />
        <circle cx="76" cy="76" r="7" />
      </g>
    </g>
  );
}

function Card({ children, name }: { children: ReactNode; name: string }) {
  return (
    <svg
      aria-label={name}
      fontFamily="Outfit, system-ui, sans-serif"
      role="img"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

function TwentySidedDie({
  dark = false,
  size,
  x,
  y,
}: {
  dark?: boolean;
  size: number;
  x: number;
  y: number;
}) {
  return (
    <g transform={`translate(${x} ${y}) scale(${size / 290})`}>
      <path d="M145 8 279 85 279 221 145 294 11 220 11 84Z" fill={dark ? "#d8442a" : "#f46a49"} />
      <path d="M145 8 11 84 145 136 279 85Z" fill={dark ? "#ff8d64" : "#ff9b71"} />
      <path d="M145 136 279 85 240 189 145 294Z" fill={dark ? "#cf3624" : "#df4b31"} />
      <path d="M11 84 145 136 50 190 11 220Z" fill={dark ? "#ed6545" : "#f97b53"} />
      <path d="M145 136 240 189 50 190Z" fill={dark ? CORAL : "#ff8b60"} />
      <path d="M50 190 240 189 145 294Z" fill={dark ? "#be2f20" : "#d8432d"} />
      <path
        d="M145 8 279 85 279 221 145 294 11 220 11 84Z M145 8 145 136 M11 84 145 136 279 85 M11 220 50 190 145 294 240 189 279 221 M11 84 50 190 240 189 279 85 M50 190 145 136 240 189"
        fill="none"
        stroke={dark ? "#3c211c" : "#783228"}
        strokeLinejoin="round"
        strokeWidth="4"
      />
      <text fill={PAPER} fontSize="43" fontWeight="650" textAnchor="middle" x="145" y="180">
        20
      </text>
      <text
        fill="#ffe0cd"
        fontSize="25"
        fontWeight="600"
        textAnchor="middle"
        transform="rotate(-18 208 149)"
        x="208"
        y="149"
      >
        8
      </text>
      <text
        fill="#612920"
        fontSize="25"
        fontWeight="600"
        textAnchor="middle"
        transform="rotate(20 96 94)"
        x="96"
        y="94"
      >
        12
      </text>
    </g>
  );
}

function SharedBoard() {
  return (
    <Card name="Little Table on a dark shared whiteboard">
      <defs>
        <pattern height="25" id="shared-board-grid" patternUnits="userSpaceOnUse" width="25">
          <circle cx="2" cy="2" fill="#4b4543" r="1.6" />
        </pattern>
        <clipPath id="shared-board-window">
          <rect height="488" rx="34" width="523" x="624" y="71" />
        </clipPath>
      </defs>
      <rect fill="#171514" height={HEIGHT} width={WIDTH} />
      <path d="M582 0H1200V630H988Z" fill="#201c1b" />
      <Logo x={67} y={94} />
      <text fill={PAPER} fontSize="96" fontWeight="710" letterSpacing="-5" x="65" y="266">
        Little
      </text>
      <text fill={PAPER} fontSize="96" fontWeight="710" letterSpacing="-5" x="65" y="363">
        Table
      </text>
      <text fill="#d8cbc5" fontSize="35" x="70" y="435">
        Draw together.
      </text>
      <text fill="#d8cbc5" fontSize="35" x="70" y="478">
        Roll together.
      </text>
      <rect
        fill="#262221"
        height="488"
        rx="34"
        stroke="#4b4240"
        strokeWidth="3"
        width="523"
        x="624"
        y="71"
      />
      <g clipPath="url(#shared-board-window)">
        <rect fill="url(#shared-board-grid)" height="488" width="523" x="624" y="71" />
        <path
          d="M685 432C736 390 695 342 733 306S815 330 849 283 827 212 911 181 1005 170 1053 131"
          fill="none"
          stroke="#9fb3a4"
          strokeDasharray="10 12"
          strokeLinecap="round"
          strokeWidth="5"
        />
        <g
          fill="none"
          stroke="#81938a"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="4"
        >
          <path d="m701 257 39-71 45 71h-21l-24-41-14 27 9 14Z" />
          <path d="m809 245 39-68 44 68h-22l-22-39-12 24 9 15Z" />
          <path d="M955 229v-43h15v13h18v-13h15v43M946 230h66" />
        </g>
        <circle cx="742" cy="315" fill="#e1b177" r="8" />
        <circle cx="915" cy="180" fill="#9fb3a4" r="8" />
        <g transform="rotate(-12 958 374)">
          <TwentySidedDie dark size={191} x={865} y={279} />
        </g>
        <g transform="translate(790 378)">
          <path
            d="M0 0 17 41 22 24 39 17Z"
            fill="#89b99b"
            stroke="#262221"
            strokeLinejoin="round"
            strokeWidth="3"
          />
        </g>
        <path
          d="M646 505h166a15 15 0 0 1 15 15v13a15 15 0 0 1-15 15H646a15 15 0 0 1-15-15v-13a15 15 0 0 1 15-15Z"
          fill="#332d2b"
          stroke="#514945"
          strokeWidth="2"
        />
        <rect fill={CORAL} height="29" rx="8" width="33" x="640" y="512" />
        <path d="m651 518 5 14 2-6 6-1Z" fill={PAPER} />
        <path
          d="m689 532 12-11 5 5-12 11Z M728 519v14h14v-14Z M769 519v15m-6-15h12"
          fill="none"
          stroke="#d8cbc5"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="3"
        />
      </g>
    </Card>
  );
}

function DiceNight() {
  return (
    <Card name="Little Table with a twenty-sided die on a coral background">
      <rect fill="#fb6a49" height={HEIGHT} width={WIDTH} />
      <path d="M668 0H1200V630H765L545 342Z" fill="#f0573c" />
      <circle cx="954" cy="315" fill="none" r="223" stroke="#f89a79" strokeWidth="2" />
      <circle cx="954" cy="315" fill="none" r="182" stroke="#f89a79" strokeWidth="2" />
      <path
        d="M824 527h242m-221 16h201"
        opacity=".45"
        stroke="#ca3b2b"
        strokeLinecap="round"
        strokeWidth="7"
      />
      <ellipse cx="956" cy="502" fill="#913228" opacity=".28" rx="143" ry="23" />
      <g transform="rotate(11 945 301)">
        <TwentySidedDie dark size={375} x={755} y={111} />
      </g>
      <g transform="translate(68 95)">
        <rect fill="#32211d" height="63" rx="17" width="63" />
        <rect fill={PAPER} height="33" rx="8" width="33" x="15" y="15" />
        <circle cx="24" cy="24" fill="#32211d" r="3.5" />
        <circle cx="31.5" cy="31.5" fill="#32211d" r="3.5" />
        <circle cx="39" cy="39" fill="#32211d" r="3.5" />
      </g>
      <text fill="#321e19" fontSize="111" fontWeight="730" letterSpacing="-6" x="63" y="273">
        Little
      </text>
      <text fill="#321e19" fontSize="111" fontWeight="730" letterSpacing="-6" x="63" y="384">
        Table
      </text>
      <text fill="#321e19" fontSize="35" fontWeight="510" x="70" y="466">
        The tabletop whiteboard.
      </text>
    </Card>
  );
}

function MapNotes() {
  return (
    <Card name="Little Table next to a hand-drawn tabletop map on paper">
      <defs>
        <pattern height="31" id="map-notes-grid" patternUnits="userSpaceOnUse" width="31">
          <path d="M31 0H0V31" fill="none" stroke="#e0d4c2" strokeWidth="1.3" />
        </pattern>
      </defs>
      <rect fill="#f3e9da" height={HEIGHT} width={WIDTH} />
      <path d="M628 0H1200V630H685L555 484Z" fill="#e8dbca" />
      <Logo size={58} x={69} y={114} />
      <text fill={INK} fontSize="92" fontWeight="710" letterSpacing="-5" x="66" y="300">
        Little Table
      </text>
      <text fill="#574a3b" fontSize="35" fontWeight="500" x="72" y="370">
        A shared whiteboard for
      </text>
      <text fill="#574a3b" fontSize="35" fontWeight="500" x="72" y="413">
        tabletop games.
      </text>
      <g transform="translate(648 121) rotate(-8 229 196)">
        <rect fill="#d6c8b5" height="384" rx="18" width="456" x="8" y="12" />
        <rect fill="#fdf6e9" height="384" rx="18" stroke="#d0beaa" strokeWidth="2" width="456" />
        <rect fill="url(#map-notes-grid)" height="352" rx="10" width="424" x="16" y="16" />
        <path
          d="M29 282c85 26 83-76 153-71s54 64 124 34c44-19 32-83 120-109"
          fill="none"
          stroke="#748b74"
          strokeDasharray="8 12"
          strokeLinecap="round"
          strokeWidth="5"
        />
        <g
          fill="none"
          stroke="#615949"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="4"
        >
          <path d="M48 161 96 79l52 82m-69-51 17 13 17-14M123 136l30-51 44 76m-56-59 12 11 13-10" />
          <path d="M267 143V89h20v17h22V89h20v54m-71 0h79m-41 0v-16q8-12 17 0v16" />
          <path d="M86 306c14-17 38-19 49-4-14 17-38 19-49 4Zm10 0h29" />
          <path d="M333 305h15m-7-7v15m37-33h13m-6-7v13" />
        </g>
        <circle cx="183" cy="211" fill={CORAL} r="8" />
        <circle cx="386" cy="152" fill="#748b74" r="8" />
      </g>
      <g transform="rotate(12 1005 421)">
        <TwentySidedDie size={152} x={923} y={338} />
      </g>
    </Card>
  );
}

const concepts = {
  "dice-night": { title: "Dice night", render: <DiceNight /> },
  "map-notes": { title: "Map notes", render: <MapNotes /> },
  "shared-board": { title: "Shared board", render: <SharedBoard /> },
};

const [concept, output] = process.argv.slice(2);
if (
  output === undefined ||
  concept === undefined ||
  (concept !== "gallery" && !Object.hasOwn(concepts, concept))
) {
  throw new Error(
    "Usage: bun scripts/open-graph.tsx <shared-board|dice-night|map-notes|gallery> <output>",
  );
}
const font = await readFile(
  new URL("../client/src/theme/fonts/outfit-latin.woff2", import.meta.url),
);
const documentCss = `
  @font-face { font-family: Outfit; src: url(data:font/woff2;base64,${font.toString("base64")}) format("woff2"); font-weight: 100 900; }
  body { margin: 0; }
  svg { display: block; width: 100%; height: auto; }
`;
function documentOf(content: string, style = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${documentCss}${style}</style></head><body>${content}</body></html>`;
}

if (concept === "gallery") {
  const gallery = (
    <main className="ui-stack">
      <header className="ui-header">
        <h1 className="ui-title">Little Table share cards</h1>
        <p className="ui-sub">Three React designs for the image that appears with shared links.</p>
      </header>
      {Object.values(concepts).map(({ render, title }) => (
        <section key={title}>
          <h2 className="ui-section">{title}</h2>
          {render}
        </section>
      ))}
    </main>
  );
  await writeFile(
    output,
    documentOf(
      renderToStaticMarkup(gallery),
      `
    main { display: grid; gap: 20px; }
    h1, h2, p { margin: 0; }
    h2 { margin-bottom: 8px; }
    svg { border-radius: var(--radius); }
  `,
    ),
  );
} else {
  const browser = await chromium.launch({ args: ["--ozone-platform=headless"] });
  try {
    const page = await browser.newPage({ viewport: { height: HEIGHT, width: WIDTH } });
    await page.setContent(
      documentOf(renderToStaticMarkup(concepts[concept as keyof typeof concepts].render)),
    );
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: output, type: "png" });
  } finally {
    await browser.close();
  }
}
