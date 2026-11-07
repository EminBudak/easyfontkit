"use strict";

// A font kit from a website: the page is opened in a headless browser on a
// 1600x900 desktop screen, walked from top to bottom, and read once. What
// comes out, in one folder:
//
//   FONTS.md    the fonts of headings, body text, buttons and code, each
//               family's license and maker, and the closest free fonts, for
//               people and coding agents
//   fonts.css   a @font-face rule for every saved file and, per role, the
//               site's font and its closest free font as CSS variables
//   fonts.json  everything above, for tools
//   files/      every font file the page loaded, as the browser received it
//
// Nothing is written while the page is read. The kit is then made in a
// part folder inside its folder and moved in place of an earlier kit there
// in one go, so a run that fails or is stopped leaves the folder as it was.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { launch, killBrowsers, openPage } = require("./chrome");
const { scanPage } = require("./scan");
const { buildFamilies, parseStack } = require("./families");
const { SOURCE_NAMES } = require("./license");
const { styleWords, words } = require("./match");
const { setTimeLimit } = require("./time");
const version = require("./version");

const SCREEN = { width: 1600, height: 900 };
const ROLE_NAMES = { heading: "Headings", body: "Body text", button: "Buttons", code: "Code" };
const ROLE_WORDS = { heading: "headings", body: "body text", button: "buttons", code: "code" };
const GENERIC = { sans: "sans-serif", serif: "serif", mono: "monospace" };
const STATUS = { open: "Open", commercial: "Commercial", unknown: "Unknown", system: "System font" };

// "acme.com", "www.acme.com/pricing" and "https://acme.com" all mean a web
// address; anything that is not http(s) is refused.
function normalizeUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Give a website address, for example: easyfontkit acme.com");
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error(`Not a web address: ${text}`);
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new Error(`Not a web address: ${text}`);
  return url.href;
}

// The font files an earlier kit lists, by name only: a fonts.json someone
// edited cannot point a run outside the kit's files folder.
function kitFiles(kit) {
  return []
    .concat(kit.families || [])
    .flatMap((family) => [].concat((family && family.files) || []).map((file) => file && file.file))
    .filter((file) => typeof file === "string" && file)
    .map((file) => path.basename(file))
    .filter((name) => name && name !== "." && name !== "..");
}

function entry(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}
const exists = (file) => Boolean(entry(file));
// What a kit writes: a file, never a folder. A link counts, as the link.
const isFile = (file) => {
  const stat = entry(file);
  return Boolean(stat && (stat.isFile() || stat.isSymbolicLink()));
};

// A run's part folder in the kit's folder: .easyfontkit-part-<pid>-<random>.
const PART = /^\.easyfontkit-part-(\d+)-[0-9a-f]{8}$/;

// The kit's folder as a run finds it: null when it is missing or empty, or
// the earlier kit there, with the names of its font files that are in
// files/ as files. A folder that holds anything else is refused, so a run
// never mixes into or replaces someone's files. Part folders do not count.
// Nothing is changed.
function earlierKit(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => !PART.test(name));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (!names.length) return null;
  let old = null;
  try {
    old = JSON.parse(fs.readFileSync(path.join(dir, "fonts.json"), "utf8"));
  } catch {
    // Not a kit.
  }
  if (!old || old.version !== 1 || !String(old.generator || "").startsWith("easyfontkit")) {
    throw new Error(`${dir} is not empty and holds no earlier font kit. Pick another folder with --out.`);
  }
  return { files: [...new Set(kitFiles(old))].filter((name) => isFile(path.join(dir, "files", name))) };
}

// The names in the kit's files folder that the earlier kit does not list:
// the user's own, which a new font file never takes. Compared without case,
// as macOS and Windows disks compare them.
function ownFiles(dir, earlier) {
  const kit = new Set((earlier ? earlier.files : []).map((name) => name.toLowerCase()));
  try {
    return fs.readdirSync(path.join(dir, "files")).filter((name) => !kit.has(name.toLowerCase()));
  } catch {
    return [];
  }
}

// Windows can refuse a rename for a moment while a virus scanner reads a
// file that was just written, so there it is tried again for up to two
// seconds, waiting in place like the rest of the move.
function rename(from, to) {
  for (let waited = 0; ; waited += 50) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(err.code) || waited >= 2_000) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Another user's process.
    return err.code === "EPERM";
  }
}

// Made with mkdir, not mkdtemp: under a default ACL, mkdtemp's mode 0700
// would shut out the others that ACL lets into the folder, like a hosted
// worker that removes what a killed run left.
function makePart(dir) {
  for (;;) {
    const part = path.join(dir, `.easyfontkit-part-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    try {
      fs.mkdirSync(part);
      return part;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

// The new kit, made in the part folder, put in place of the earlier kit.
// The earlier kit's own files go aside into the part folder, fonts.json
// first, and the new ones come in, fonts.json last, so a fonts.json in the
// folder always belongs to a whole kit. Each step is a rename within the
// folder that never replaces anything, and one that fails puts back every
// file moved before it.
function putInPlace(dir, part, earlier) {
  const aside = path.join(part, "earlier");
  const files = path.join(part, "files");
  const withFiles = exists(files);
  const moved = [];
  const move = (from, to) => {
    if (exists(to)) throw new Error(`${path.relative(dir, to)} is in the way`);
    rename(from, to);
    moved.push([from, to]);
  };
  try {
    if (earlier) {
      fs.mkdirSync(path.join(aside, "files"), { recursive: true });
      for (const name of ["fonts.json", "FONTS.md", "fonts.css"]) {
        if (isFile(path.join(dir, name))) move(path.join(dir, name), path.join(aside, name));
      }
      for (const name of earlier.files) move(path.join(dir, "files", name), path.join(aside, "files", name));
    }
    for (const name of ["FONTS.md", "fonts.css"]) move(path.join(part, name), path.join(dir, name));
    if (withFiles && !exists(path.join(dir, "files"))) move(files, path.join(dir, "files"));
    else if (withFiles) for (const name of fs.readdirSync(files)) move(path.join(files, name), path.join(dir, "files", name));
    move(path.join(part, "fonts.json"), path.join(dir, "fonts.json"));
  } catch (err) {
    let back = true;
    for (const [from, to] of moved.reverse()) {
      try {
        rename(to, from);
      } catch {
        back = false;
      }
    }
    const error = new Error(`The new kit could not be put in place in ${dir} (${err.message}), so ${back ? "the earlier kit there is as it was" : `some of the earlier kit's files are in ${aside}`}.`);
    // The part folder then holds what could not be put back, and stays.
    error.keepPart = !back;
    throw error;
  }
  // As before, without font files: a files folder that held only the
  // earlier kit's goes too.
  if (!withFiles) {
    try {
      fs.rmdirSync(path.join(dir, "files"));
    } catch {
      // Missing, or holding files of the user's.
    }
  }
}

// The folders made for a kit that was not saved, from the kit's folder up
// to the first one made, as long as they are empty.
function removeMade(dir, made) {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    try {
      fs.rmdirSync(at);
    } catch {
      return;
    }
    if (at === path.resolve(made)) return;
  }
}

// Once the new kit is in place: the part folder, which holds the earlier
// kit by then, and the part folders of runs killed outright while they
// wrote their kit, whose process has ended. Another process's run that is
// still going keeps its own. Nothing here fails the run: what cannot be
// removed is left for the next run.
function tidy(dir, part) {
  const folders = [part];
  try {
    for (const name of fs.readdirSync(dir)) {
      const pid = Number((PART.exec(name) || [])[1]);
      // This process has no other part folder at this point: one under its
      // own pid is a leftover of an earlier process that had the same pid.
      if (pid && name !== path.basename(part) && (pid === process.pid || !alive(pid))) folders.push(path.join(dir, name));
    }
  } catch {
    // Only this run's own, then.
  }
  for (const folder of folders) {
    try {
      fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Left for the next run.
    }
  }
}

// The kit, written by write() into a part folder of its own inside dir and
// put in place of the earlier kit there, or nothing at all: on any error
// the part folder goes, and so do the folders made for it. All of it runs
// without a pause, so a stop signal is handled before it starts or after it
// is done, never halfway. The folder is read again here, as it can have
// changed while the page was read.
function saveKit(dir, write) {
  const earlier = earlierKit(dir);
  const made = fs.mkdirSync(dir, { recursive: true });
  let part = "";
  try {
    part = makePart(dir);
    write(part, ownFiles(dir, earlier));
    putInPlace(dir, part, earlier);
  } catch (err) {
    if (part && !err.keepPart) {
      try {
        fs.rmSync(part, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // Left for the next run that ends well in this folder.
      }
    }
    if (made) removeMade(dir, made);
    throw err;
  }
  tidy(dir, part);
}

const slug = (text) =>
  String(text || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "font";

const weightText = ({ min, max }) => (min === max ? String(min) : `${min} ${max}`);

// files/<family>-<weight or "variable">[-<style>][-italic].<format>, the
// style when it is more than a weight ("grid" in Geist Pixel Grid), and
// numbered when two files would still share a name (the latin and
// latin-ext parts of one weight) or a name a file of the user's has in the
// kit's files folder (own).
function saveFiles(families, dir, own = []) {
  const taken = new Set(own.map((name) => name.toLowerCase()));
  fs.mkdirSync(path.join(dir, "files"));
  for (const family of families) {
    for (const file of family.files) {
      // A variable file's style is only its default instance.
      const style = file.variable ? [] : styleWords(file.style).filter((word) => !words(family.name).some((part) => part.toLowerCase() === word.toLowerCase()));
      const stem = `${slug(family.name)}-${file.variable ? "variable" : file.weight.min}${style.length ? `-${slug(style.join(" "))}` : ""}${file.italic ? "-italic" : ""}`;
      let name = `${stem}.${file.format}`;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-${n}.${file.format}`;
      taken.add(name.toLowerCase());
      fs.writeFileSync(path.join(dir, "files", name), file.buffer);
      file.file = `files/${name}`;
    }
  }
}

const quote = (name) => `"${String(name).replace(/["\\]/g, "\\$&")}"`;
// Generic families and system keywords stay bare: quoted, they would name a
// font called "sans-serif".
const cssName = (name) => (/^(-apple-system|BlinkMacSystemFont|system-ui|ui-[a-z-]+|serif|sans-serif|monospace|cursive|fantasy|emoji|math)$/i.test(name) ? name : quote(name));

// The weights a free family is loaded in: each weight the site uses, moved
// to the nearest one the family has.
function freeWeights(free, used) {
  const have = free.weights.length ? free.weights : [400];
  const pick = (w) => have.reduce((best, h) => (Math.abs(h - w) < Math.abs(best - w) ? h : best), have[0]);
  return [...new Set((used.length ? used : [400]).map(pick))].sort((a, b) => a - b);
}

function freeImports(picks) {
  const google = picks.filter(({ free }) => free.from === "Google Fonts");
  const lines = [];
  if (google.length) {
    const families = google.map(({ free, weights }) => `family=${free.family.replace(/ /g, "+")}:wght@${weights.join(";")}`);
    lines.push(`@import url("https://fonts.googleapis.com/css2?${families.join("&")}&display=swap");`);
  }
  for (const { free, weights } of picks.filter(({ free }) => free.from !== "Google Fonts")) {
    for (const w of weights) lines.push(`@import url("https://cdn.jsdelivr.net/npm/@fontsource/${free.id}/${w}.css");`);
  }
  return lines;
}

// The free family each role falls back to: the role's own family when it is
// open, else its first free match.
function freePick(family) {
  if (!family) return null;
  if (family.license.status === "open" && !family.system) return { name: family.name, own: true };
  const free = family.free[0];
  return free ? { name: free.family, free } : null;
}

function writeCss(kit, families, dir) {
  const byKey = new Map(families.map((family) => [family.key, family]));
  const host = new URL(kit.url).hostname.replace(/^www\./, "");
  const picks = new Map();
  for (const role of Object.values(kit.roles)) {
    const pick = freePick(byKey.get(role.key));
    if (!pick || !pick.free) continue;
    const used = picks.get(pick.free.id) || { free: pick.free, used: new Set() };
    role.weights.forEach((w) => used.used.add(w));
    picks.set(pick.free.id, used);
  }
  const imports = freeImports([...picks.values()].map(({ free, used }) => ({ free, weights: freeWeights(free, [...used]) })));
  const lines = [
    `/* Fonts of ${host}, read from ${kit.url} on ${kit.capturedAt.slice(0, 10)} by easyfontkit ${version}.`,
    "   Each font file the page loaded has a @font-face rule below, under its",
    "   family's name. --font-heading, --font-body, --font-button and --font-code",
    "   are the site's own fonts; the -free ones are the closest free fonts.",
    "   FONTS.md says how each one is licensed. */",
    "",
    ...imports,
  ];
  if (imports.length) lines.push("");
  for (const family of families) {
    for (const file of family.files.filter((f) => f.file)) {
      lines.push(
        "@font-face {",
        `  font-family: ${quote(family.name)};`,
        `  src: url("${file.file}") format("${file.format === "ttf" ? "truetype" : file.format === "otf" ? "opentype" : file.format}");`,
        `  font-weight: ${weightText(file.weight)};`,
        `  font-style: ${file.italic ? "italic" : "normal"};`,
        ...(file.unicodeRange ? [`  unicode-range: ${file.unicodeRange};`] : []),
        "  font-display: swap;",
        "}",
        "",
      );
    }
  }
  lines.push(":root {");
  for (const [role, info] of Object.entries(kit.roles)) {
    const family = byKey.get(info.key);
    const stack = parseStack(info.stack);
    const generic = GENERIC[family ? family.category : "sans"];
    const own = family && !family.system ? [quote(family.name), ...stack.filter((name) => !family.cssNames.some((css) => css.toLowerCase() === name.toLowerCase())).map(cssName)] : stack.map(cssName);
    if (!own.includes(generic)) own.push(generic);
    lines.push(`  --font-${role}: ${[...new Set(own)].join(", ")};`);
    const pick = freePick(family);
    if (pick) lines.push(`  --font-${role}-free: ${quote(pick.name)}, ${generic};`);
  }
  lines.push("}", "");
  fs.writeFileSync(path.join(dir, "fonts.css"), lines.join("\n"));
}

const short = (text, n) => {
  const one = String(text || "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1).trim()}…` : one;
};
const list = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

const sentence = (text) => {
  const one = String(text || "").trim();
  return one ? `${one.charAt(0).toUpperCase()}${one.slice(1)}${/[.!?]["”']?$/.test(one) ? "" : "."}` : "";
};

function licenseLine(family) {
  const l = family.license;
  if (family.system) return "None needed from the site: it sends no file and asks for a font already on the visitor's computer.";
  const head = { open: `Open${l.name ? `, ${l.name}` : ""}.`, commercial: "Commercial.", unknown: "Unknown." }[l.status];
  // The file's own words say it best; the reasoning is given when they are
  // missing or when the call came from somewhere else.
  const fromText = /^the font file (says|names)/.test(l.basis);
  const parts = [head];
  if (!fromText || !l.text) parts.push(sentence(l.basis));
  if (l.text) parts.push(`The file says "${short(l.text, 200)}"${/[.!?]$/.test(short(l.text, 200)) ? "" : "."}`);
  if (l.url) parts.push(`License page: ${l.url}`);
  return parts.join(" ");
}

function writeMarkdown(kit, families, dir) {
  const byKey = new Map(families.map((family) => [family.key, family]));
  const host = new URL(kit.url).hostname.replace(/^www\./, "");
  const lines = [`# Fonts of ${host}`, "", `Read from ${kit.url} on ${kit.capturedAt.slice(0, 10)} by easyfontkit ${version}.`, ""];
  const roles = Object.entries(kit.roles);
  if (roles.length) {
    lines.push("| Role | Font | Weights | License | Closest free font |", "| --- | --- | --- | --- | --- |");
    for (const [role, info] of roles) {
      const family = byKey.get(info.key);
      const pick = freePick(family);
      const free = !pick ? "" : pick.own ? "itself" : pick.name;
      const also = info.also.length ? `, also ${list(info.also)}` : "";
      lines.push(`| ${ROLE_NAMES[role]} | ${info.family}${info.italic ? " (italic)" : ""}${also} | ${info.weights.join(", ")} | ${STATUS[family.license.status]} | ${free} |`);
    }
  } else {
    lines.push("No text was found in headings, body text, buttons or code.");
  }
  const section = (family) => {
    lines.push("", `## ${family.name}`, "");
    if (family.roles.length) lines.push(`- Used for: ${list(family.roles.map((role) => ROLE_WORDS[role]))}`);
    else lines.push("- Loaded by the page, but not drawn in its headings, body text, buttons or code");
    if (family.system) {
      lines.push(`- CSS: \`${family.stack}\``);
      if (family.drawnWith) lines.push(`- Drawn here with ${family.drawnWith}; each visitor gets their own system's font`);
    } else {
      if (family.cssNames.length && !family.cssNames.every((name) => name === family.name)) lines.push(`- CSS name: ${family.cssNames.join(", ")}`);
      const service = SOURCE_NAMES[family.source];
      lines.push(`- Served from: ${service && family.host ? `${service} (${family.host})` : family.host || service || "unknown"}`);
      if (family.license.maker) lines.push(`- Maker: ${family.license.maker}`);
      if (family.license.designer && family.license.designer !== family.license.maker) lines.push(`- Designer: ${family.license.designer}`);
      if (family.license.copyright) lines.push(`- Copyright: ${short(family.license.copyright, 160)}`);
    }
    lines.push(`- License: ${licenseLine(family)}`);
    if (family.files.length) {
      const saved = family.files.map((file) => `${file.file || file.url} (${file.variable ? `variable, weights ${file.weight.min} to ${file.weight.max}` : `weight ${file.weight.min}`}${file.italic ? ", italic" : ""}, ${Math.round(file.bytes / 1024)} KB)`);
      lines.push(`- Files: ${saved.join("; ")}`);
    } else if (family.missing) {
      lines.push("- Files: Chrome drew with it, but its file was not caught");
    }
    if (family.listed && family.license.status === "open") lines.push(`- Also on ${family.listed.from}: ${family.listed.from === "Google Fonts" ? `https://fonts.google.com/specimen/${family.listed.family.replace(/ /g, "+")}` : `https://fontsource.org/fonts/${family.listed.id}`}`);
    if (family.free.length) {
      lines.push("- Closest free fonts:");
      for (const free of family.free) lines.push(`  - ${free.family} (${free.from}, ${free.license}): ${free.basis}`);
    }
  };
  const drawn = families.filter((family) => family.roles.length);
  const others = families.filter((family) => !family.roles.length);
  drawn.forEach(section);
  if (others.length) {
    lines.push("", "## Other fonts the page loads", "", "These files were loaded too, but none of the text read above was drawn with them: icon fonts, or text further from the usual places.");
    others.forEach(section);
  }
  lines.push(
    "",
    "## How to use",
    "",
    "fonts.css declares every saved file under its family's name and sets a variable per role. Keep it next to the files folder:",
    "",
    "```css",
    '@import "fonts.css";',
    "h1, h2, h3 { font-family: var(--font-heading); }",
    "body { font-family: var(--font-body); }",
    "```",
    "",
    "`--font-heading` and the others are the site's own fonts. `--font-heading-free` and the other -free variables are the closest free fonts, loaded from Google Fonts or Fontsource. A commercial font is licensed by its maker, and the site's license does not carry over to other uses.",
  );
  if (kit.notes.length) lines.push("", "## Notes", "", ...kit.notes.map((note) => `- ${note}`));
  fs.writeFileSync(path.join(dir, "FONTS.md"), lines.join("\n") + "\n");
}

function publicFamily(family) {
  return {
    ...family,
    files: family.files.map((file) => ({
      file: file.file || "",
      url: file.url,
      format: file.format,
      weight: file.weight,
      style: file.style,
      italic: file.italic,
      variable: file.variable,
      unicodeRange: file.unicodeRange,
      bytes: file.bytes,
    })),
  };
}

// The runs going on in this process, for a stop signal.
const runs = new Set();

async function makeFontKit(rawUrl, { dir, files = true, timeLimit = 120_000, log = () => {} } = {}) {
  setTimeLimit(timeLimit);
  const url = normalizeUrl(rawUrl);
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  const target = dir || `easyfontkit-${host}`;
  // A folder of someone else's is refused before the page is read.
  const run = { dir: target, earlier: Boolean(earlierKit(target)) };
  runs.add(run);
  try {
    let scan;
    const chrome = await launch(SCREEN);
    let cdp;
    try {
      cdp = await openPage(chrome.base, SCREEN);
      scan = await scanPage(cdp, url, log);
    } finally {
      if (cdp) cdp.close();
      await chrome.close();
    }
    // Nothing waits from here to the end.
    if (scan.challenge) {
      throw new Error(`${scan.pageUrl} answered with a bot check ("${scan.challenge}") instead of its page, so no kit was made. Open the site in a normal browser and try again later.`);
    }
    if (!Object.keys(scan.roles).length && !scan.files.length) {
      throw new Error(`${scan.pageUrl} showed no text and loaded no fonts, so nothing was read. The site may turn away headless browsers; check the page in a normal browser.`);
    }
    log("Reading the font files");
    const built = buildFamilies(scan);
    let kit;
    saveKit(target, (part, own) => {
      if (files) saveFiles(built.families, part, own);
      const notes = [...built.notes];
      for (const skipped of scan.skipped) notes.push(`${skipped.url} was not a usable font file: ${skipped.reason}.`);
      if (!files) notes.push("Run with --no-files: the font files were read but not saved.");
      kit = {
        version: 1,
        url: scan.pageUrl,
        capturedAt: new Date().toISOString(),
        generator: `easyfontkit ${version}`,
        roles: built.roles,
        families: built.families.map(publicFamily),
        notes,
      };
      fs.writeFileSync(path.join(part, "fonts.json"), JSON.stringify(kit, null, 2) + "\n");
      writeMarkdown(kit, kit.families, part);
      writeCss(kit, kit.families, part);
    });
    return { dir: target, kit };
  } finally {
    runs.delete(run);
  }
}

// For a process that is being stopped: the runs going on, none of which
// has written anything yet, and their browsers, which are killed at once.
function stopRuns() {
  const stopped = [...runs];
  runs.clear();
  killBrowsers();
  return stopped;
}

module.exports = { makeFontKit, normalizeUrl, earlierKit, saveKit, stopRuns, slug };
