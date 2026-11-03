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
// fsType: 0x0004 }.
function interAs({ names = {}, fsType } = {}) {
  const tables = woffTables(fixture("inter-latin-400.woff"));
  if (Object.keys(names).length) tables.name = nameTable(names);
  if (fsType !== undefined) tables["OS/2"].writeUInt16BE(fsType, 8);
  return sfnt(tables);
}

module.exports = { fixture, interAs };
