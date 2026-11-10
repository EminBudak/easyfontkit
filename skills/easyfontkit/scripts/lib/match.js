"use strict";

// The closest free fonts to one that is not free. Well-known paid fonts
// have hand-picked matches (data/lookalikes.json). Any other font is
// matched on its proportions against every free text font on Fontsource
// (data/fonts.json): x-height, cap height and the width of its lowercase,
// within the same kind of font (sans, serif or monospace). The index also
// says whether a family is itself free, and under which license.

const INDEX = require("../data/fonts.json");
const LOOKALIKES = require("../data/lookalikes.json");

const FONTS = INDEX.fonts.map((row) => Object.fromEntries(INDEX.fields.map((field, i) => [field, row[i]])));
const BY_ID = new Map(FONTS.map((font) => [font.id, font]));

// Words a file or a style sheet adds to a family's name: its weight, its
// style, or that it is the variable or web version.
const EXTRA = new Set([
  "vf", "var", "variable", "web", "webfont", "wf", "regular", "normal", "book", "roman", "italic", "oblique",
  "thin", "hairline", "extralight", "ultralight", "light", "medium", "semibold", "demibold", "bold", "extrabold",
  "ultrabold", "black", "heavy", "extrablack", "ultrablack", "semi", "demi", "extra", "ultra",
  // Klim and other German foundries name their weights in German.
  "extraleicht", "leicht", "buch", "kraftig", "kräftig", "halbfett", "dreiviertelfett", "fett", "extrafett", "kursiv",
]);

// A name in words. One written without spaces ("SFMono-Regular",
// "InterVariable") is split where its capitals start a word.
function words(name) {
  let text = String(name || "").trim().replace(/^(['"])(.*)\1$/, "$2");
  if (!/\s/.test(text)) text = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return text.split(/[\s_\-.,]+/).filter(Boolean);
}

const key = (parts) =>
  parts
    .join("")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

// Optical sizes ("Google Sans 18pt") go too.
function strip(parts) {
  const out = [...parts];
  while (out.length > 1 && (EXTRA.has(out[out.length - 1].toLowerCase()) || /^\d+pt$/i.test(out[out.length - 1]))) out.pop();
  return out;
}

const BY_KEY = new Map(FONTS.map((font) => [key(words(font.family)), font]));
const CURATED = new Map(LOOKALIKES.fonts.flatMap((entry) => entry.names.map((name) => [key(words(name)), entry])));

// The Fontsource family a name stands for: as written ("Archivo Black" is a
// family of its own), else without its weight and version words ("Inter
// Medium" and "Inter Variable" are Inter).
function lookup(name) {
  const parts = words(name);
  if (!parts.length) return null;
  return BY_KEY.get(key(parts)) || BY_KEY.get(key(strip(parts))) || null;
}

// The hand-picked entry for a name: as written, else without the words a
// file adds, dropped one at a time from the end ("Times New Roman Bold" is
// Times New Roman, "Gotham Book" is Gotham, "Arial Black" is Arial).
function curated(name) {
  const parts = words(name);
  for (let n = parts.length; n > 0; n--) {
    const entry = CURATED.get(key(parts.slice(0, n)));
    if (entry) return entry;
    const last = parts[n - 1];
    if (n === 1 || !(EXTRA.has(last.toLowerCase()) || /^\d+pt$/i.test(last))) break;
  }
  return null;
}

// Cuts that are a design of their own under a family's name: Arial Black is
// not Arial drawn heavier, nor Arial Narrow Arial drawn narrower, and
// neither keeps Arial's widths or its line breaks. A name is such a cut when
// a word after its first is a heavy weight or another width.
const HEAVY = new Set(["black", "heavy", "extrablack", "ultrablack"]);
const WIDTH = /^(semi|extra|ultra)?(narrow|condensed|compressed|extended|expanded)$/;
const ownWidths = (name) => words(name).slice(1).some((word) => HEAVY.has(word.toLowerCase()) || WIDTH.test(word.toLowerCase()));

// An entry without the free fonts that keep its family's widths, the ones
// its metric list names, and with the reason for the others: null when it
// has no others.
function withoutMetric(entry) {
  const metric = new Set(entry.metric || []);
  if (!metric.size) return entry;
  const free = entry.free.filter((id) => !metric.has(id));
  return free.length ? { ...entry, free, basis: entry.basisWithoutMetric } : null;
}

// A family's name as people write it: Fontsource's own spelling when it
// lists the family, else without the words a file adds ("Söhne VF" is
// Söhne, "Lyon Text Web" is Lyon Text). With keepCut, a heavy weight and
// the words before it stay, for a font on the visitor's computer: Arial-Black
// is Arial Black, a design of its own, not Arial drawn heavier.
function cleanName(name, { keepCut = false } = {}) {
  const listed = lookup(name);
  if (listed) return listed.family;
  const parts = strip(words(name));
  if (keepCut) {
    const all = words(name);
    const heavy = all.findLastIndex((word, i) => i > 0 && HEAVY.has(word.toLowerCase()));
    if (heavy >= parts.length) return all.slice(0, heavy + 1).join(" ");
  }
  return parts.join(" ");
}

// The words of a style name that are not a weight or a slant: "Grid" in
// Geist Pixel Grid, "Condensed" in "Condensed Bold". Empty for "Bold Italic".
const styleWords = (style) => words(style).filter((word) => !EXTRA.has(word.toLowerCase()) && !/^\d+pt$/i.test(word));

const KIND = { sans: "sans serif", serif: "serif", mono: "monospaced" };
const DEFAULTS = { sans: "inter", serif: "source-serif-4", mono: "jetbrains-mono" };
const MEASURES = [
  ["xHeight", 3, "x-height"],
  ["capHeight", 1.5, "cap height"],
  ["lowercaseWidth", 2.5, "lowercase width"],
];

function described(font, basis) {
  return {
    id: font.id,
    family: font.family,
    from: font.type === "g" ? "Google Fonts" : "Fontsource",
    license: font.license,
    weights: String(font.weights || "")
      .split(",")
      .map(Number)
      .filter(Boolean),
    basis,
  };
}

// A free family of the index by its id, as freeMatches gives one, or null.
const indexed = (id, basis = "") => (BY_ID.has(id) ? described(BY_ID.get(id), basis) : null);

const round = (n) => Math.round(n * 100) / 100;

// Families made for one use are poor stand-ins for a text face: small caps,
// condensed or decorative cuts, and the Latin side of a font made for
// another script (filtered by the index's script field).
const NOT_TEXT = /\b(SC|Unjoined|Expanded|Condensed|Narrow|Wide|Stencil|Outline|Shadow|Inline|Caption|Hairline|Math|Symbols|Icons?|Emoji)\b/;
// Among fonts of near the same proportions, the well-made, well-known ones
// come first: Google Fonts' popularity rank weighs in, gently. A family with
// one or two weights is kept, after the fuller ones.
// Google files some slab serifs as plain serifs: the ones named so, and a
// few well-known ones that are not.
const isSlab = (font) => Boolean(font.slab) || /\b(Slab|Bitter|Crete Round|Kreon)\b/i.test(font.family);
const PREFER = 0.006;
const UNRANKED = 3000;
const FEW_WEIGHTS = 0.005;

// metrics: { xHeight, capHeight, lowercaseWidth }, each a share of the em,
// as sfnt.describeFont reads them. names: every name the font goes by (its
// family, its CSS names), tried in order on the hand-picked list; or stacks,
// the CSS font stacks a font on the visitor's computer is asked for by, one
// for each role. stack: the names are CSS font stacks, so a free family one
// names (a site asking for Inter where Inter is not installed) is the match
// itself. slab: the font is a slab serif itself; slab serifs are matched
// only then.
function freeMatches({ names = [], stacks = [names], category = "sans", metrics = null, count = 3, stack = false, slab = false } = {}) {
  const kind = DEFAULTS[category] ? category : "sans";
  // A free font that keeps a family's widths holds for the family's own
  // weights only: not for a cut drawn to other widths, nor for the names
  // after one in a stack, which are its fallbacks. In "Arial Black", Arial
  // or "Arial Black", Helvetica, no name gets Arimo. Another role's stack
  // follows no cut, so it starts again.
  for (const list of stacks) {
    let cut = false;
    for (const name of list) {
      cut = cut || ownWidths(name);
      const found = curated(name);
      const entry = found && cut ? withoutMetric(found) : found;
      if (entry) return entry.free.map((id) => BY_ID.get(id)).filter(Boolean).map((font) => described(font, entry.basis));
      const listed = stack ? lookup(name) : null;
      if (listed) return [described(listed, "the site's font stack names it, and it is free")];
    }
  }
  const m = metrics || {};
  const have = MEASURES.filter(([field]) => typeof m[field] === "number" && m[field] > 0);
  if (have.length >= 2) {
    const total = have.reduce((sum, [, weight]) => sum + weight, 0);
    const scored = FONTS.filter(
      (font) =>
        font.category === kind &&
        !font.script &&
        !font.display &&
        isSlab(font) === slab &&
        !NOT_TEXT.test(font.family) &&
        have.every(([field]) => typeof font[field] === "number"),
    )
      .map((font) => {
        const spread = Math.sqrt(have.reduce((sum, [field, weight]) => sum + weight * (font[field] - m[field]) ** 2, 0) / total);
        return { font, score: spread + PREFER * Math.log10(font.popularity || UNRANKED) + (String(font.weights || "").split(",").length < 3 ? FEW_WEIGHTS : 0) };
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, count);
    return scored.map(({ font }) =>
      described(font, `close in proportions: ${have.map(([field, , label]) => `${label} ${round(font[field])} against ${round(m[field])}`).join(", ")}`),
    );
  }
  return [described(BY_ID.get(DEFAULTS[kind]), `a plain free ${KIND[kind]} font; this one could not be measured`)];
}

module.exports = { freeMatches, indexed, lookup, cleanName, styleWords, words, key, FONTS };
