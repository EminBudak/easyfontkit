#!/usr/bin/env node
"use strict";

// Builds skills/easyfontkit/scripts/data/fonts.json: every Fontsource
// family's id, name, category, license and weights; for text faces
// (sans-serif, serif and monospace) the proportions a lookalike is matched
// on, read from the regular latin file; and from Google Fonts' own catalog,
// how popular a family is, which script it is made for first, and whether
// Google files it as a display face or a slab serif. Not shipped; run it by hand when the
// index should be refreshed:
//
//   node tools/build-index.js               reuses the measurements it has
//   node tools/build-index.js --remeasure   downloads and measures again

const fs = require("fs");
const path = require("path");
const { describeFont } = require("../skills/easyfontkit/scripts/lib/sfnt");

const OUT = path.join(__dirname, "../skills/easyfontkit/scripts/data/fonts.json");
const CATEGORY = { "sans-serif": "sans", serif: "serif", monospace: "mono", display: "display", handwriting: "handwriting", other: "other" };
const MEASURED = new Set(["sans-serif", "serif", "monospace"]);
const FIELDS = ["id", "family", "category", "license", "type", "weights", "xHeight", "capHeight", "lowercaseWidth", "monospace", "popularity", "script", "display", "slab"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function measure(font) {
  if (!MEASURED.has(font.category) || !(font.subsets || []).includes("latin")) return null;
  const weights = font.weights || [];
  if (!weights.length) return null;
  const weight = weights.includes(400) ? 400 : weights.reduce((best, w) => (Math.abs(w - 400) < Math.abs(best - 400) ? w : best));
  const style = (font.styles || []).includes("normal") ? "normal" : "italic";
  const url = `https://cdn.jsdelivr.net/fontsource/fonts/${font.id}@latest/latin-${weight}-${style}.woff2`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return null;
      const m = describeFont(Buffer.from(await res.arrayBuffer()));
      return { xHeight: m.xHeight, capHeight: m.capHeight, lowercaseWidth: m.lowercaseWidth, monospace: m.monospace ? 1 : 0 };
    } catch {
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

// Google Fonts' catalog, as its own site loads it. It starts with a guard
// line against being run as a script.
async function googleCatalog() {
  const res = await fetch("https://fonts.google.com/metadata/fonts", { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Google Fonts answered ${res.status}`);
  const text = (await res.text()).replace(/^\)\]\}'\s*/, "");
  return new Map(JSON.parse(text).familyMetadataList.map((family) => [family.family, family]));
}

function earlier() {
  try {
    const index = JSON.parse(fs.readFileSync(OUT, "utf8"));
    const at = (name) => index.fields.indexOf(name);
    return new Map(
      index.fonts.map((row) => [
        row[at("id")],
        row[at("lowercaseWidth")] ? { xHeight: row[at("xHeight")], capHeight: row[at("capHeight")], lowercaseWidth: row[at("lowercaseWidth")], monospace: row[at("monospace")] } : null,
      ]),
    );
  } catch {
    return new Map();
  }
}

async function main() {
  const remeasure = process.argv.includes("--remeasure");
  const res = await fetch("https://api.fontsource.org/v1/fonts", { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Fontsource answered ${res.status}`);
  const list = (await res.json()).sort((a, b) => a.id.localeCompare(b.id));
  const google = await googleCatalog();
  const known = remeasure ? new Map() : earlier();
  const rows = new Array(list.length);
  let next = 0;
  let measured = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const font = list[i];
      const m = known.has(font.id) ? known.get(font.id) : await measure(font);
      if (m && m.xHeight && m.lowercaseWidth) measured++;
      const g = google.get(font.family);
      const script = (g && g.primaryScript) || (font.defSubset && font.defSubset !== "latin" ? font.defSubset : "");
      rows[i] = [
        font.id,
        font.family,
        CATEGORY[font.category] || "other",
        font.license || "",
        font.type === "google" ? "g" : "o",
        (font.weights || []).join(","),
        m && m.xHeight ? m.xHeight : null,
        m && m.capHeight ? m.capHeight : null,
        m && m.lowercaseWidth ? m.lowercaseWidth : null,
        m ? m.monospace : null,
        g && g.popularity ? g.popularity : null,
        script,
        g && (g.classifications || []).includes("Display") ? 1 : 0,
        g && g.stroke === "Slab Serif" ? 1 : 0,
      ];
      if (i % 100 === 0) process.stderr.write(`${i}/${list.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  const index = {
    source: "Fontsource (https://fontsource.org) and the Google Fonts catalog (https://fonts.google.com)",
    built: new Date().toISOString().slice(0, 10),
    fields: FIELDS,
    fonts: rows,
  };
  fs.writeFileSync(OUT, JSON.stringify(index) + "\n");
  console.log(`${rows.length} families, ${measured} measured, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB: ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
