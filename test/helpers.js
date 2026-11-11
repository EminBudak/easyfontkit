"use strict";

// Test fonts made from the OFL Inter fixture: a TrueType file rebuilt from
// its WOFF tables, with the names and embedding bits a test asks for. Only
// tests use this; it is not shipped.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const FIXTURES = path.join(__dirname, "fixtures");
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

function woffTables(buf) {
  const count = buf.readUInt16BE(12);
  const tables = {};
  for (let i = 0; i < count; i++) {
    const entry = 44 + i * 20;
    const tag = buf.toString("latin1", entry, entry + 4);
    const start = buf.readUInt32BE(entry + 4);
    const compressed = buf.readUInt32BE(entry + 8);
    const original = buf.readUInt32BE(entry + 12);
    const data = buf.subarray(start, start + compressed);
    tables[tag] = Buffer.from(compressed < original ? zlib.inflateSync(data) : data);
  }
  return tables;
}

// A format 0 name table with Windows English records.
function nameTable(records) {
  const entries = Object.entries(records).map(([id, text]) => [Number(id), Buffer.from(String(text), "utf16le").swap16()]);
  entries.sort((a, b) => a[0] - b[0]);
  const header = Buffer.alloc(6 + entries.length * 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(entries.length, 2);
  header.writeUInt16BE(header.length, 4);
  let offset = 0;
  entries.forEach(([id, bytes], i) => {
    const at = 6 + i * 12;
    header.writeUInt16BE(3, at);
    header.writeUInt16BE(1, at + 2);
    header.writeUInt16BE(0x409, at + 4);
    header.writeUInt16BE(id, at + 6);
    header.writeUInt16BE(bytes.length, at + 8);
    header.writeUInt16BE(offset, at + 10);
    offset += bytes.length;
  });
  return Buffer.concat([header, ...entries.map(([, bytes]) => bytes)]);
}

function checksum(buf) {
  const padded = Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4)]);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

function sfnt(tables) {
  const tags = Object.keys(tables).sort();
  const count = tags.length;
  const entrySelector = Math.floor(Math.log2(count));
  const searchRange = 2 ** entrySelector * 16;
  const header = Buffer.alloc(12 + count * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(count, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(count * 16 - searchRange, 10);
  const head = Buffer.from(tables.head);
  head.writeUInt32BE(0, 8);
  const bodies = [];
  let offset = header.length;
  tags.forEach((tag, i) => {
    const data = tag === "head" ? head : tables[tag];
    const at = 12 + i * 16;
    header.write(tag, at, 4, "latin1");
    header.writeUInt32BE(checksum(data), at + 4);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(data.length, at + 12);
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  });
  const font = Buffer.concat([header, ...bodies]);
  const headAt = header.readUInt32BE(12 + tags.indexOf("head") * 16 + 8);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headAt + 8);
  return font;
}

// Inter as a TrueType file under other names: { names: {1: "Acme Sans", ...},
// fsType: 0x0004 }, or with a name table or a cmap of the test's own, as
// they are: { name, cmap }.
function interAs({ names = {}, fsType, name, cmap } = {}) {
  const tables = woffTables(fixture("inter-latin-400.woff"));
  if (Object.keys(names).length) tables.name = nameTable(names);
  if (name) tables.name = name;
  if (cmap) tables.cmap = cmap;
  if (fsType !== undefined) tables["OS/2"].writeUInt16BE(fsType, 8);
  return sfnt(tables);
}

// A cmap with one subtable, of format 12, whose groups each give one glyph
// to a character: the first `count` of `codes(i)`, in order.
function cmap12(count, codes = (i) => 2 * i) {
  const table = Buffer.alloc(12 + 16 + count * 12);
  table.writeUInt16BE(1, 2);
  table.writeUInt16BE(3, 4);
  table.writeUInt16BE(10, 6);
  table.writeUInt32BE(12, 8);
  table.writeUInt16BE(12, 12);
  table.writeUInt32BE(16 + count * 12, 16);
  table.writeUInt32BE(count, 24);
  for (let i = 0; i < count; i++) {
    const at = 28 + i * 12;
    table.writeUInt32BE(codes(i), at);
    table.writeUInt32BE(codes(i), at + 4);
    table.writeUInt32BE(i + 1, at + 8);
  }
  return table;
}

// Data that unpacks to `megabytes` MB of zeros, after `first` when it is
// given, packed as it streams so the zeros are never held whole: with
// brotli, or with zlib's deflate.
async function packedZeros(megabytes, brotli, first = Buffer.alloc(0)) {
  const stream = brotli ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : zlib.createDeflate({ level: 9 });
  const out = [];
  stream.on("data", (chunk) => out.push(chunk));
  const done = new Promise((resolve) => stream.on("end", resolve));
  if (first.length) stream.write(first);
  const zeros = Buffer.alloc(1 << 20);
  for (let i = 0; i < megabytes; i++) if (!stream.write(zeros)) await new Promise((resolve) => stream.once("drain", resolve));
  stream.end();
  await done;
  return Buffer.concat(out);
}

// A WOFF2 file with one table, its name table or the one WOFF2 numbers
// `table` (0 for cmap), whose directory says it is `declared` bytes long,
// followed by `packed` as its brotli stream.
function woff2With(declared, packed, table = 5) {
  const digits = [];
  for (let n = declared; ; n = Math.floor(n / 128)) {
    digits.unshift(n % 128);
    if (n < 128) break;
  }
  const length = Buffer.from(digits.map((digit, i) => (i < digits.length - 1 ? digit | 0x80 : digit)));
  const header = Buffer.alloc(48);
  header.write("wOF2", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(Math.min(declared + 28, 0xffffffff), 16);
  header.writeUInt32BE(packed.length, 20);
  const file = Buffer.concat([header, Buffer.from([table]), length, packed]);
  file.writeUInt32BE(file.length, 8);
  return file;
}

// A WOFF file with one table, its name table, `packed` with zlib's deflate,
// whose directory says it unpacks to `declared` bytes.
function woffWith(declared, packed) {
  const header = Buffer.alloc(64);
  header.write("wOFF", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(Math.min(declared + 28, 0xffffffff), 16);
  header.write("name", 44, "latin1");
  header.writeUInt32BE(64, 48);
  header.writeUInt32BE(packed.length, 52);
  header.writeUInt32BE(declared, 56);
  const file = Buffer.concat([header, packed]);
  file.writeUInt32BE(file.length, 8);
  return file;
}

module.exports = { fixture, interAs, cmap12, packedZeros, woff2With, woffWith };
