"use strict";

// What a font file says about itself, read with Node's own zlib: its names
// (family, maker, copyright, license), how it may be embedded, and the
// measurements a lookalike is matched on. WOFF2, WOFF, TrueType, OpenType
// and the first font of a collection. Glyph outlines are never decoded.

const zlib = require("zlib");

// WOFF2 names the common tables by index (WOFF2 spec, table 3).
const WOFF2_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ",
  "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS",
  "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc",
  "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop",
  "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

function base128(buf, pos) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[pos.i++];
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return value;
  }
  throw new Error("a WOFF2 length is malformed");
}

function sfntTables(buf, offset = 0) {
  const count = buf.readUInt16BE(offset + 4);
  const tables = {};
  for (let i = 0; i < count; i++) {
    const entry = offset + 12 + i * 16;
    const tag = buf.toString("latin1", entry, entry + 4);
    const start = buf.readUInt32BE(entry + 8);
    const length = buf.readUInt32BE(entry + 12);
    if (start + length <= buf.length) tables[tag] = buf.subarray(start, start + length);
  }
  return tables;
}

function woffTables(buf) {
  const count = buf.readUInt16BE(12);
  const tables = {};
  for (let i = 0; i < count; i++) {
    const entry = 44 + i * 20;
    const tag = buf.toString("latin1", entry, entry + 4);
    const start = buf.readUInt32BE(entry + 4);
    const compressed = buf.readUInt32BE(entry + 8);
    const original = buf.readUInt32BE(entry + 12);
    if (start + compressed > buf.length) throw new RangeError("a WOFF table runs past the file's end");
    const data = buf.subarray(start, start + compressed);
    tables[tag] = compressed < original ? zlib.inflateSync(data) : data;
  }
  return tables;
}

// Only glyf, loca and hmtx can be stored transformed; those come back as
// null, which no reader here needs except hmtx (and it has a fallback).
function woff2Tables(buf) {
  const count = buf.readUInt16BE(12);
  const compressedLength = buf.readUInt32BE(20);
  const pos = { i: 48 };
  const directory = [];
  for (let k = 0; k < count; k++) {
    const flags = buf[pos.i++];
    let tag = WOFF2_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) {
      tag = buf.toString("latin1", pos.i, pos.i + 4);
      pos.i += 4;
    }
    const version = (flags >> 6) & 3;
    const original = base128(buf, pos);
    const transformed = tag === "glyf" || tag === "loca" ? version === 0 : version !== 0;
    directory.push({ tag, length: transformed ? base128(buf, pos) : original, transformed });
  }
  if (buf.toString("latin1", 4, 8) === "ttcf") throw new Error("a WOFF2 font collection, which easyfontkit does not read yet");
  if (pos.i + compressedLength > buf.length) throw new RangeError("the WOFF2 tables run past the file's end");
  const data = zlib.brotliDecompressSync(buf.subarray(pos.i, pos.i + compressedLength));
  const tables = {};
  let offset = 0;
  for (const table of directory) {
    tables[table.tag] = table.transformed ? null : data.subarray(offset, offset + table.length);
    offset += table.length;
  }
  return tables;
}

function readTables(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new Error("too short to be a font");
  const signature = buf.toString("latin1", 0, 4);
  if (signature === "wOF2") return { format: "woff2", tables: woff2Tables(buf) };
  if (signature === "wOFF") return { format: "woff", tables: woffTables(buf) };
  if (signature === "ttcf") return { format: "ttc", tables: sfntTables(buf, buf.readUInt32BE(12)) };
  if (signature === "OTTO") return { format: "otf", tables: sfntTables(buf) };
  if (buf.readUInt32BE(0) === 0x00010000 || signature === "true") return { format: "ttf", tables: sfntTables(buf) };
  throw new Error("not a font file");
}

// Name records, Windows English first, then any Windows, then Mac Roman.
// Every string the table holds, on any platform and in any language, also
// goes into `all` when given: Chrome can name a face by any of them.
function readNames(table, all) {
  const names = {};
  if (!table || table.length < 6) return names;
  const count = table.readUInt16BE(2);
  const strings = table.readUInt16BE(4);
  const rank = {};
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12;
    if (record + 12 > table.length) break;
    const platform = table.readUInt16BE(record);
    const language = table.readUInt16BE(record + 4);
    const id = table.readUInt16BE(record + 6);
    const length = table.readUInt16BE(record + 8);
    const start = strings + table.readUInt16BE(record + 10);
    if (start + length > table.length) continue;
    const raw = table.subarray(start, start + length);
    let text;
    if (platform === 3 || platform === 0) {
      text = "";
      for (let k = 0; k + 1 < raw.length; k += 2) text += String.fromCharCode(raw.readUInt16BE(k));
    } else if (platform === 1) {
      text = raw.toString("latin1");
    } else continue;
    if (all && text.trim() && text.length <= 100) all.add(text.trim());
    const score = platform === 3 && language === 0x409 ? 3 : platform === 3 ? 2 : 1;
    if (!(id in names) || score > rank[id]) {
      names[id] = text.trim();
      rank[id] = score;
    }
  }
  return names;
}

// A name a font hides on purpose (".\x7f", control characters) is no name.
const readable = (text) => (text && /^[\p{L}\p{N}][\p{L}\p{N}\p{P}\p{Zs}+&'’-]*$/u.test(text) ? text : "");

function embeddingOf(fsType) {
  if (fsType & 0x0002) return "restricted";
  if (fsType & 0x0004) return "preview and print";
  if (fsType & 0x0008) return "editable";
  return "installable";
}

// Glyph id for a character, from a format 4 or 12 cmap subtable, or null
// when the cmap has neither.
function glyphLookup(cmap) {
  if (!cmap || cmap.length < 4) return null;
  const count = cmap.readUInt16BE(2);
  let best = null;
  for (let i = 0; i < count; i++) {
    const record = 4 + i * 8;
    const platform = cmap.readUInt16BE(record);
    const encoding = cmap.readUInt16BE(record + 2);
    const offset = cmap.readUInt32BE(record + 4);
    if (offset + 2 > cmap.length) continue;
    const format = cmap.readUInt16BE(offset);
    const score = format === 12 && platform === 3 && encoding === 10 ? 3 : format === 4 && platform === 3 && encoding === 1 ? 2 : format === 4 || format === 12 ? 1 : 0;
    if (score && (!best || score > best.score)) best = { offset, format, score };
  }
  if (!best) return null;
  const t = cmap.subarray(best.offset);
  if (best.format === 12) {
    const groups = t.readUInt32BE(12);
    return (code) => {
      for (let g = 0; g < groups; g++) {
        const at = 16 + g * 12;
        const start = t.readUInt32BE(at);
        const end = t.readUInt32BE(at + 4);
        if (code >= start && code <= end) return t.readUInt32BE(at + 8) + (code - start);
      }
      return 0;
    };
  }
  const segments = t.readUInt16BE(6) / 2;
  const ends = 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  return (code) => {
    for (let s = 0; s < segments; s++) {
      if (code > t.readUInt16BE(ends + s * 2)) continue;
      const start = t.readUInt16BE(starts + s * 2);
      if (code < start) return 0;
      const delta = t.readInt16BE(deltas + s * 2);
      const rangeOffset = t.readUInt16BE(ranges + s * 2);
      if (!rangeOffset) return (code + delta) & 0xffff;
      const at = ranges + s * 2 + rangeOffset + (code - start) * 2;
      if (at + 2 > t.length) return 0;
      const glyph = t.readUInt16BE(at);
      return glyph ? (glyph + delta) & 0xffff : 0;
    }
    return 0;
  };
}

// The mean advance width of a to z, as a share of the em: one width that
// means the same thing in every font, unlike OS/2's average, which each
// maker counts over a different set of glyphs.
function lowercaseWidth(tables, upm) {
  const { cmap, hhea, hmtx } = tables;
  if (!cmap || !hhea || !hmtx || !upm) return null;
  const metrics = hhea.readUInt16BE(34);
  if (!metrics) return null;
  const glyph = glyphLookup(cmap);
  if (!glyph) return null;
  let sum = 0;
  let found = 0;
  for (let code = 97; code <= 122; code++) {
    const id = glyph(code);
    if (!id) continue;
    const at = Math.min(id, metrics - 1) * 4;
    if (at + 2 > hmtx.length) continue;
    sum += hmtx.readUInt16BE(at);
    found++;
  }
  return found >= 20 ? Math.round((sum / found / upm) * 1000) / 1000 : null;
}

function readAxes(fvar) {
  if (!fvar || fvar.length < 16) return [];
  const start = fvar.readUInt16BE(4);
  const count = fvar.readUInt16BE(8);
  const size = fvar.readUInt16BE(10);
  const fixed = (at) => Math.round((fvar.readInt32BE(at) / 65536) * 100) / 100;
  const axes = [];
  for (let i = 0; i < count; i++) {
    const at = start + i * size;
    if (at + 20 > fvar.length) break;
    axes.push({ tag: fvar.toString("latin1", at, at + 4), min: fixed(at + 4), default: fixed(at + 8), max: fixed(at + 12) });
  }
  return axes;
}

// A file whose tables, or the header that says where they are, run past its
// end, as in a file cut short or broken, makes Node's buffer reads throw
// their own words, which name offsets: they are said plainly instead.
function plainly(buf, read) {
  try {
    return read();
  } catch (err) {
    if (err instanceof RangeError || err.code === "ERR_OUT_OF_RANGE" || err.code === "ERR_BUFFER_OUT_OF_BOUNDS") {
      throw new Error(`cut short or broken: its tables run past its ${buf.length} bytes`);
    }
    throw err;
  }
}

// Everything easyfontkit uses from a font file. Throws on a file that is not
// a font; returns empty fields for tables a file leaves out.
function describeFont(buf) {
  return plainly(buf, () => describeTables(buf));
}

function describeTables(buf) {
  const { format, tables } = readTables(buf);
  const all = new Set();
  const names = readNames(tables.name, all);
  const upm = tables.head && tables.head.length >= 20 ? tables.head.readUInt16BE(18) : 0;
  const share = (n) => (upm && Number.isFinite(n) && n > 0 ? Math.round((n / upm) * 1000) / 1000 : null);
  const os2 = tables["OS/2"];
  const fsType = os2 && os2.length >= 10 ? os2.readUInt16BE(8) : 0;
  const version = os2 && os2.length >= 2 ? os2.readUInt16BE(0) : 0;
  const post = tables.post;
  const family = readable(names[16]) || readable(names[1]);
  return {
    format,
    family,
    style: readable(names[17]) || readable(names[2]),
    fullName: readable(names[4]),
    postscriptName: readable(names[6]),
    hiddenNames: !family && Boolean(names[1] || names[16]),
    copyright: names[0] || "",
    manufacturer: names[8] || "",
    designer: names[9] || "",
    vendorUrl: names[11] || "",
    designerUrl: names[12] || "",
    license: names[13] || "",
    licenseUrl: names[14] || "",
    vendorId: os2 && os2.length >= 62 ? os2.toString("latin1", 58, 62).replace(/[^\x20-\x7e]/g, "").trim() : "",
    embedding: embeddingOf(fsType),
    fsType,
    weight: os2 && os2.length >= 6 ? os2.readUInt16BE(4) : null,
    italic: Boolean((os2 && os2.length >= 64 && os2.readUInt16BE(62) & 1) || (post && post.length >= 8 && post.readInt32BE(4) !== 0)),
    monospace: Boolean(post && post.length >= 16 && post.readUInt32BE(12)),
    panose: os2 && os2.length >= 42 ? [...os2.subarray(32, 42)] : [],
    unitsPerEm: upm,
    xHeight: version >= 2 && os2.length >= 90 ? share(os2.readInt16BE(86)) : null,
    capHeight: version >= 2 && os2.length >= 90 ? share(os2.readInt16BE(88)) : null,
    averageWidth: os2 && os2.length >= 4 ? share(os2.readInt16BE(2)) : null,
    lowercaseWidth: lowercaseWidth(tables, upm),
    axes: readAxes(tables.fvar),
    names: [...all],
  };
}

// Whether a font file has a glyph for a character, by its code point, read
// from its cmap: a function of the code point, or null when the file has
// no cmap that can be read.
function glyphsOf(buf) {
  try {
    const { tables } = readTables(buf);
    const glyph = glyphLookup(tables.cmap);
    if (!glyph) return null;
    return (code) => {
      try {
        return glyph(code) > 0;
      } catch {
        return false;
      }
    };
  } catch {
    return null;
  }
}

module.exports = { describeFont, glyphsOf };
