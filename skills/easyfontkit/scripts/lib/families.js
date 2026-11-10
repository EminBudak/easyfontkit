"use strict";

// From what the page scan saw to fonts a person can use. Each face Chrome
// drew a role with is tied to its files, the files are grouped into
// families, and every family gets where it came from, its license and, when
// it is not free, the closest free fonts.

const { licenseOf, sourceOf, redact } = require("./license");
const { freeMatches, lookup, cleanName, words, key } = require("./match");

const ROLE_ORDER = ["heading", "body", "button", "code"];
const ROLE_WORDS = { heading: "headings", body: "body text", button: "buttons", code: "code" };
const SYSTEM_KEYWORD = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|math|emoji|fangsong|-apple-system|blinkmacsystemfont)$/i;
// A family name that is not one: some sites ship their files under a
// stand-in ("TN Web Use Only") with a scrambled PostScript name.
const STAND_IN = /\buse only\b|\bnot licensed\b|\bmunged\b/i;
// A face drawing less of a role's text than this is a fallback for a few
// characters (an arrow, an emoji) the role's own font does not have.
const MIN_SHARE = 0.15;

const bare = (url) => String(url || "").split("#")[0];
const noQuery = (url) => bare(url).split("?")[0];
const lower = (text) => String(text || "").toLowerCase();
// "a", "a and b", "a, b and c".
const listOf = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

function parseStack(stack) {
  return String(stack || "")
    .split(",")
    .map((part) => part.trim().replace(/^(['"])(.*)\1$/, "$2").trim())
    .filter(Boolean);
}

const topOf = (counts) => Object.entries(counts || {}).sort((a, b) => b[1] - a[1]).map(([value]) => value);

// The system font a stack asks for, by a name people know.
const SYSTEM_NAMES = {
  "system-ui": "System UI font",
  "-apple-system": "System UI font",
  blinkmacsystemfont: "System UI font",
  "ui-sans-serif": "System UI font",
  "ui-serif": "System serif font",
  "ui-monospace": "System monospace font",
  "ui-rounded": "System rounded font",
  "sans-serif": "The browser's sans serif",
  serif: "The browser's serif",
  monospace: "The browser's monospace",
  cursive: "The browser's cursive",
  fantasy: "The browser's fantasy font",
};
// A CSS name written as an identifier ("nyt-franklin") is kept as written;
// one written as a name ("Airbnb Cereal VF") is cleaned like a file's.
const cssDisplay = (name, options) => (/^[a-z0-9-]+$/.test(name) ? name : cleanName(name, options) || name);
// A font on the visitor's computer is named as the CSS asks for it when the
// CSS writes it as a name with spaces: the words a file adds to a name are
// part of a system family's own name there, like Roman in Times New Roman
// or Black in Arial Black. One written as a single word, like the PostScript
// names SFMono-Regular and HelveticaNeue-Bold, is cleaned like a file's, so
// it is SF Mono, and Helvetica Neue with the rest of its family; but a
// heavy cut keeps its weight, so Arial-Black is Arial Black, a family of its
// own, as when it is written with a space.
const systemName = (family) => SYSTEM_NAMES[lower(family)] || (/\s/.test(family) ? family : cssDisplay(family, { keepCut: true }));

// A unicode-range as fonts.css can carry it: code points and ranges of them,
// apart by commas, else nothing. The rules read from a style sheet's text
// keep what the page wrote there, and copied as it is, a range with a quote
// or a semicolon in it could end its line in fonts.css and add declarations
// of the page's choosing, like a src from elsewhere.
const RANGE = /^u\+[0-9a-f?]{1,6}(-[0-9a-f]{1,6})?$/i;
function unicodeRange(text) {
  const parts = String(text || "")
    .split(",")
    .map((part) => part.trim());
  return parts.every((part) => RANGE.test(part)) ? parts.join(", ") : "";
}

// The CSS families each file is declared under: by its address in the
// @font-face rules, and by Chrome's own report of the web fonts it loaded.
function declareFiles(files, rules, faces) {
  for (const file of files) {
    const exact = new Set(file.urls.map(bare));
    const loose = new Set(file.urls.map(noQuery));
    let declared = rules.filter((rule) => rule.urls.some((url) => exact.has(bare(url))));
    if (!declared.length) declared = rules.filter((rule) => rule.urls.some((url) => loose.has(noQuery(url))));
    declared = [...declared, ...faces.filter((face) => exact.has(bare(face.src)))];
    file.cssFamilies = [...new Set(declared.map((rule) => rule.family).filter(Boolean))];
    // The characters the site loads this file for: a family split into
    // latin and latin-ext files needs it to pick the right one.
    file.unicodeRange = declared.map((rule) => unicodeRange(rule.unicodeRange)).find(Boolean) || "";
  }
}

// A file's family as people name it: from the file itself, else from the
// CSS family it is declared under, else from its address.
function fileFamily(file) {
  if (file.font.family && !STAND_IN.test(file.font.family)) return cleanName(file.font.family);
  if (file.cssFamilies.length) return cssDisplay(file.cssFamilies[0]);
  const url = file.urls.find((address) => !address.startsWith("data:")) || "";
  const base = decodeURIComponent(noQuery(url).split("/").pop() || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[.-][a-f0-9]{6,}$/i, "");
  return /[a-z]{3}/i.test(base) ? cleanName(base) : "";
}

// The files a face Chrome drew with comes from: by the PostScript or
// family name Chrome reports, found among every name each file carries;
// by Chrome's own report of the web fonts it loaded; else by the first
// family of the CSS stack that has files. Several matches are narrowed to
// the ones the stack asks for.
function filesOfFace(face, stack, files, faces) {
  const named = (name) => (name ? files.filter((file) => file.font.names.includes(name)) : []);
  let found = named(face.postScriptName);
  if (!found.length) found = named(face.familyName);
  if (!found.length && face.familyName) {
    const sources = new Set(faces.filter((loaded) => loaded.platformFamily === face.familyName).map((loaded) => bare(loaded.src)));
    found = files.filter((file) => file.urls.some((url) => sources.has(bare(url))));
  }
  const asked = new Set(stack.map(lower));
  const inStack = (file) => file.cssFamilies.some((name) => asked.has(lower(name)));
  if (found.length > 1 && found.some(inStack)) found = found.filter(inStack);
  if (!found.length) {
    for (const name of stack) {
      const declared = files.filter((file) => file.cssFamilies.some((css) => lower(css) === lower(name)));
      if (declared.length) return declared;
    }
  }
  return found;
}

function categoryOf(font, stacks, roles, listed) {
  if (font && (font.monospace || (font.panose[0] === 2 && font.panose[3] === 9))) return "mono";
  if (font && font.panose[0] === 2 && font.panose[1] >= 2 && font.panose[1] <= 10) return "serif";
  if (font && font.panose[0] === 2 && font.panose[1] >= 11 && font.panose[1] <= 15) return "sans";
  const generics = stacks.flatMap(parseStack).map(lower);
  if (generics.some((name) => name === "monospace" || name === "ui-monospace")) return "mono";
  if (generics.some((name) => name === "serif" || name === "ui-serif")) return "serif";
  if (generics.some((name) => ["sans-serif", "system-ui", "ui-sans-serif", "-apple-system"].includes(name))) return "sans";
  if (listed && ["sans", "serif", "mono"].includes(listed.category)) return listed.category;
  return roles.includes("code") ? "mono" : "sans";
}

// The weights a family's files cover: a variable file its whole wght axis,
// a static one its own weight.
function fileWeight(font) {
  const axis = font.axes.find((a) => a.tag === "wght");
  if (axis) return { min: Math.round(axis.min), max: Math.round(axis.max) };
  const w = font.weight && font.weight >= 1 && font.weight <= 1000 ? font.weight : 400;
  return { min: w, max: w };
}

// The file the license is read from: the one that says the most.
function telling(files) {
  const score = ({ font }) => (font.license ? 4 : 0) + (font.licenseUrl ? 2 : 0) + (font.manufacturer ? 1 : 0) + (font.copyright ? 1 : 0);
  return [...files].sort((a, b) => score(b) - score(a))[0];
}

// The file the proportions are read from: upright, nearest to regular, and
// measurable.
function regular(files) {
  const rank = ({ font }) => (font.italic ? 1000 : 0) + Math.abs((fileWeight(font).min + fileWeight(font).max) / 2 - 400) + (font.lowercaseWidth ? 0 : 500);
  return [...files].sort((a, b) => rank(a) - rank(b))[0];
}

// A web family whose files the browser asked for and did not get while the
// page was read, with no other file of it read, and not one Chrome drew
// with either.
const unloaded = (family) => Boolean(family.notLoaded && family.notLoaded.size && !family.files.length && !family.missing);

function buildFamilies(scan) {
  const { pageUrl, roles: rawRoles, files, rules, faces, loaded, asked = [], skipped = [] } = scan;
  declareFiles(files, rules, faces);
  const loadedNames = new Set(loaded.map((face) => lower(face.family)));
  const families = new Map();
  const familyOf = (name, extra) => {
    const id = name ? key(words(name)) : `file-${families.size + 1}`;
    if (!families.has(id)) families.set(id, { key: id, name: name || "Unnamed font", system: false, cssNames: new Set(), files: [], roles: [], weightsUsed: new Set(), stacks: [], ...extra });
    return families.get(id);
  };
  for (const file of files) {
    const family = familyOf(fileFamily(file));
    family.files.push(file);
    file.cssFamilies.forEach((name) => family.cssNames.add(name));
  }
  const familyOfFile = new Map([...families.values()].flatMap((family) => family.files.map((file) => [file.sha, family])));

  const missingFamily = (name) => {
    const shown = cssDisplay(name);
    const family = familyOf(/\p{L}/u.test(shown) ? shown : "Unnamed font", { missing: true });
    if (/\p{L}/u.test(name)) family.cssNames.add(name);
    return family;
  };
  // The web family a stack asks for before any system font: the first name
  // the CSS gives files to, or one Chrome loaded as a web font.
  const webFamilyIn = (stack) => {
    for (const name of stack) {
      if (SYSTEM_KEYWORD.test(name)) return null;
      const declared = files.find((file) => file.cssFamilies.some((css) => lower(css) === lower(name)));
      if (declared) return familyOfFile.get(declared.sha);
      if (loadedNames.has(lower(name))) return missingFamily(name);
    }
    return null;
  };
  // A web family the stack asks for before any other font, none of whose
  // files was read, though the page's own @font-face rules give it files
  // the browser asked for: they had not come when the page was read, or did
  // not load at all. Its text was drawn with a fallback, but the site does
  // send the font, so it is no font of the visitor's own. It is named as the
  // CSS names it, with the addresses of those files. A family whose files
  // the browser never asked for, as for characters the text does not use,
  // is not one, and the browser goes on past it. A name that no @font-face
  // rule of the page declares ends the search: it is a font of the
  // visitor's own, like Arial, and the text may have been drawn with it,
  // while other text that asks for the web font first made the browser ask
  // for that font's file.
  const askedFor = new Set(asked.map(bare));
  const unloadedIn = (stack) => {
    for (const name of stack) {
      const declared = rules.filter((rule) => lower(rule.family) === lower(name));
      if (SYSTEM_KEYWORD.test(name) || !declared.length) return null;
      const urls = declared.flatMap((rule) => rule.urls.map(bare)).filter((url) => askedFor.has(url));
      if (!urls.length) continue;
      const shown = cssDisplay(name);
      const family = familyOf(/\p{L}/u.test(shown) ? shown : "Unnamed font");
      if (/\p{L}/u.test(name)) family.cssNames.add(name);
      family.notLoaded = new Set([...(family.notLoaded || []), ...urls]);
      return family;
    }
    return null;
  };

  const fallbacks = new Map();
  const roles = {};
  for (const role of ROLE_ORDER) {
    const faceList = rawRoles[role] || [];
    const total = faceList.reduce((sum, face) => sum + face.glyphs, 0);
    const used = [];
    for (const [i, face] of faceList.entries()) {
      if (i > 0 && face.glyphs / total < MIN_SHARE) continue;
      const stackText = topOf(face.stacks)[0] || "";
      const stack = parseStack(stackText);
      let family;
      if (face.custom) {
        const found = filesOfFace(face, stack, files, faces);
        const counts = new Map();
        for (const file of found) counts.set(familyOfFile.get(file.sha), (counts.get(familyOfFile.get(file.sha)) || 0) + 1);
        family = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)[0];
        // A web font Chrome drew with whose file was not caught (served
        // from a cache the recording missed): named after its CSS family.
        if (!family) family = webFamilyIn(stack) || missingFamily(face.familyName || "Unnamed font");
      } else {
        // A system font, although the stack asks for a web font first: the
        // web font came too late for this text (font-display optional or
        // swap on a first visit), or its file had not come when the page was
        // read. It counts as the web font, the one the site means.
        family = webFamilyIn(stack) || unloadedIn(stack);
        if (family) {
          const late = fallbacks.get(family) || { drawnWith: new Set(), roles: [] };
          late.drawnWith.add(face.familyName);
          if (!late.roles.includes(role)) late.roles.push(role);
          fallbacks.set(family, late);
        } else {
          const asked = stack.find((css) => !loadedNames.has(lower(css))) || face.familyName;
          const name = systemName(asked);
          family = familyOf(`system ${name}`, { system: true, name, drawnWith: face.familyName });
        }
      }
      Object.keys(face.weights).map(Number).filter(Boolean).forEach((w) => family.weightsUsed.add(w));
      if (!family.roles.includes(role)) family.roles.push(role);
      family.stacks.push(stackText);
      let entry = used.find((known) => known.family === family);
      if (!entry) {
        entry = { family, glyphs: 0, italicGlyphs: 0, weights: {}, stack: stackText };
        used.push(entry);
      }
      entry.glyphs += face.glyphs;
      entry.italicGlyphs += face.italicGlyphs;
      for (const [weight, count] of Object.entries(face.weights)) entry.weights[weight] = (entry.weights[weight] || 0) + count;
    }
    if (!used.length) continue;
    const [main, ...others] = used.sort((a, b) => b.glyphs - a.glyphs);
    roles[role] = {
      family: main.family.name,
      key: main.family.key,
      weights: topOf(main.weights).map(Number).filter(Boolean),
      italic: main.italicGlyphs > main.glyphs / 2,
      stack: main.stack,
      also: others.map((entry) => entry.family.name),
    };
  }

  // The font files whose server answered, with an error or with no font,
  // and those the browser refused, as by CORS: a note of their own says
  // why, and trying again later is for a file that got no answer.
  const answered = new Set(skipped.map((skip) => bare(skip.url)));
  const notes = [...fallbacks].map(([family, late]) => {
    const where = late.roles.map((role) => ROLE_WORDS[role]);
    // Headings and buttons are many; body text and code are one, unless
    // another role goes with them.
    const many = where.length > 1 || late.roles.some((role) => role === "heading" || role === "button");
    const fonts = [...late.drawnWith];
    const drawn = `Some of the ${listOf(where)} ${many ? "were" : "was"} drawn with ${listOf(fonts)}, ${fonts.length > 1 ? "fallbacks" : "a fallback"}`;
    if (unloaded(family)) {
      const urls = [...family.notLoaded];
      const waiting = urls.some((url) => !answered.has(url));
      return `${drawn}, because ${family.name}'s ${urls.length === 1 ? "file" : "files"} ${listOf(urls)} did not load while the page was read. That text is counted as ${family.name}, the font the site asks for. The kit has no file of it, so its license is unknown${waiting ? ": try again later" : ""}.`;
    }
    return `${drawn}, because ${family.name} loaded too late for ${many ? "them" : "it"}. That text is counted as ${family.name}, the font the site asks for.`;
  });
  const list = [...families.values()].map((family) => describeFamily(family, pageUrl));
  const order = (family) => {
    const at = ROLE_ORDER.findIndex((role) => family.roles.includes(role));
    return at === -1 ? ROLE_ORDER.length : at;
  };
  list.sort((a, b) => order(a) - order(b) || b.files.length - a.files.length);
  return { roles, families: list, notes };
}

function describeFamily(family, pageUrl) {
  const cssNames = [...family.cssNames];
  const weightsUsed = [...family.weightsUsed].sort((a, b) => a - b);
  if (family.system) {
    const category = categoryOf(null, family.stacks, family.roles, null);
    return {
      key: family.key,
      name: family.name,
      system: true,
      drawnWith: family.drawnWith,
      stack: family.stacks[0] || "",
      roles: family.roles,
      weightsUsed,
      category,
      source: "system",
      license: { status: "system", name: "", url: "", maker: "", basis: "the site asks for a font already on the visitor's computer and sends no file" },
      files: [],
      free: freeMatches({ stacks: family.stacks.map(parseStack), category, stack: true }),
    };
  }
  // The addresses of the files the browser did not get, for a family of
  // which no file was read: where the site serves it from.
  const notLoaded = unloaded(family) ? [...family.notLoaded] : [];
  const urls = family.files.flatMap((file) => file.urls);
  const firstUrl = urls.find((url) => !url.startsWith("data:")) || urls[0] || notLoaded[0] || "";
  const source = firstUrl ? sourceOf(firstUrl, pageUrl) : "unknown";
  const listed = [family.name, ...cssNames].map(lookup).find(Boolean) || null;
  const told = family.files.length ? telling(family.files).font : {};
  const license = family.files.length
    ? licenseOf(told, { source, listed })
    : { status: "unknown", name: "", url: "", maker: "", basis: notLoaded.length ? "its file did not load while the page was read, so nothing in it could be read" : "its file was not caught, so it could not be read" };
  const reg = family.files.length ? regular(family.files).font : null;
  const category = categoryOf(reg, family.stacks, family.roles, listed);
  const metrics = reg ? { xHeight: reg.xHeight, capHeight: reg.capHeight, lowercaseWidth: reg.lowercaseWidth } : null;
  const files = family.files
    .map((file) => ({ file, weight: fileWeight(file.font) }))
    .sort((a, b) => a.weight.min - b.weight.min || Number(a.file.font.italic) - Number(b.file.font.italic))
    .map(({ file, weight }) => ({
      sha: file.sha,
      buffer: file.buffer,
      url: file.urls.find((url) => !url.startsWith("data:")) || "data URL",
      format: file.font.format,
      weight,
      style: file.font.style,
      italic: file.font.italic,
      variable: file.font.axes.length > 0,
      axes: file.font.axes,
      unicodeRange: file.unicodeRange,
      bytes: file.buffer.length,
    }));
  return {
    key: family.key,
    name: family.name,
    system: false,
    missing: Boolean(family.missing),
    ...(notLoaded.length ? { notLoaded } : {}),
    cssNames,
    roles: family.roles,
    weightsUsed,
    category,
    source,
    host: (() => {
      try {
        return new URL(firstUrl).hostname;
      } catch {
        return "";
      }
    })(),
    license: { ...license, text: redact(told.license), copyright: told.copyright || "", designer: told.designer || "", embedding: told.embedding || "" },
    listed: listed ? { id: listed.id, family: listed.family, from: listed.type === "g" ? "Google Fonts" : "Fontsource", license: listed.license } : null,
    metrics,
    files,
    // With no file to measure, a family whose files did not load is matched
    // as a font of the visitor's own is, by the stacks that ask for it.
    free:
      license.status === "open"
        ? []
        : notLoaded.length
          ? freeMatches({ stacks: family.stacks.map(parseStack), category, stack: true })
          : freeMatches({ names: [family.name, ...cssNames], category, metrics, slab: /slab/i.test(family.name) || Boolean(reg && reg.panose[1] === 6) }),
  };
}

module.exports = { buildFamilies, parseStack };
