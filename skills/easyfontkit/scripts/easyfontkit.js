#!/usr/bin/env node
"use strict";

const { makeFontKit } = require("./lib/kit");
const version = require("./lib/version");

const USAGE = `Usage: easyfontkit <url> [options]

Reads a website the way a browser draws it and saves its fonts in one
folder: which font its headings, body text, buttons and code are drawn
with, every font file the page loads, how each one is licensed, and the
closest free font for each one that is not free. FONTS.md is for people
and coding agents, fonts.css for pages, fonts.json for tools.

Options:
  --out <dir>      where to save (default: ./easyfontkit-<host>)
  --no-files       read the font files but do not save them
  --json           print fonts.json instead of a summary
  --timeout <s>    give up after this many seconds (default: 120)
  -h, --help       show this help
  -v, --version    show the version

Needs Node 22 or newer and Chrome, Chromium, Edge or Brave. Set CHROME_PATH
to pick the browser.`;

function parse(argv) {
  const options = { files: true, json: false, timeout: 120 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-v" || arg === "--version") options.version = true;
    else if (arg === "--no-files") options.files = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--out" || arg === "--timeout") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error(`${arg} needs a value`);
      if (arg === "--out") options.out = value;
      else options.timeout = Number(value);
    } else if (arg.startsWith("--out=")) options.out = arg.slice(6);
    else if (arg.startsWith("--timeout=")) options.timeout = Number(arg.slice(10));
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else rest.push(arg);
  }
  if (!(options.timeout >= 30 && options.timeout <= 600)) throw new Error("--timeout takes 30 to 600 seconds");
  if (!options.help && !options.version && rest.length !== 1) throw new Error("Give one website address, for example: easyfontkit acme.com");
  return { ...options, url: rest[0] };
}

const ROLE_LABELS = { heading: "Headings", body: "Body", button: "Buttons", code: "Code" };
const STATUS = { open: "open", commercial: "commercial", unknown: "license unknown", system: "system font" };

function summary({ dir, kit }) {
  const byKey = new Map(kit.families.map((family) => [family.key, family]));
  const host = new URL(kit.url).hostname.replace(/^www\./, "");
  const lines = [`Saved the fonts of ${host} to ${dir}`, ""];
  for (const [role, info] of Object.entries(kit.roles)) {
    const family = byKey.get(info.key);
    const free = family.license.status === "open" && !family.system ? "" : family.free[0] ? `, free match: ${family.free[0].family}` : "";
    lines.push(`  ${ROLE_LABELS[role].padEnd(9)} ${info.family} ${info.weights.join(", ")} (${STATUS[family.license.status]}${free})`);
  }
  if (!Object.keys(kit.roles).length) lines.push("  No text found in headings, body text, buttons or code");
  const saved = kit.families.flatMap((family) => family.files).filter((file) => file.file);
  const all = kit.families.flatMap((family) => family.files);
  lines.push(`  Files     ${saved.length ? `${saved.length} font file${saved.length === 1 ? "" : "s"} in ${dir}/files` : all.length ? `${all.length} read, none saved` : "none loaded"}`);
  for (const note of kit.notes) lines.push(`  Note      ${note}`);
  lines.push("", `Read ${dir}/FONTS.md for the licenses and the free matches.`);
  return lines.join("\n");
}

async function main() {
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`easyfontkit: ${err.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (options.help) return void process.stdout.write(`${USAGE}\n`);
  if (options.version) return void process.stdout.write(`${version}\n`);
  try {
    const result = await makeFontKit(options.url, {
      dir: options.out,
      files: options.files,
      timeLimit: options.timeout * 1000,
      log: options.json ? () => {} : (line) => process.stderr.write(`${line}...\n`),
    });
    process.stdout.write(options.json ? JSON.stringify(result.kit, null, 2) + "\n" : summary(result) + "\n");
  } catch (err) {
    if (options.json) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
    process.stderr.write(`easyfontkit: ${err.message}\n`);
    process.exit(1);
  }
}

main();
