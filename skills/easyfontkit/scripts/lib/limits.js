"use strict";

// The most easyfontkit reads of a page, and how the notes say why a font
// file was not read.

// The most easyfontkit keeps of the bodies of a page's font files, all
// told, as much as the browser keeps of all it loads for a page (see
// scan.js): well above any site's fonts, which come to a few megabytes,
// tens for Chinese, Japanese or Korean. A page could serve font files of
// tens of megabytes each, which the run would hold until it ends, on a
// server for every user's job too. The browser itself still holds what the
// page loads, as any browser does.
const FONT_BYTES = 200 * 1024 * 1024;

// The most easyfontkit reads of one font file: the most the browser keeps
// of one file for it, and the most the tables of one may unpack to (see
// sfnt.js). No web font comes near: the largest, for Chinese, Japanese or
// Korean, unpack to a few tens of megabytes.
const FILE_BYTES = 64 * 1024 * 1024;

const inMB = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

// Why a font file was not read, as a note says it of one file and of
// several.
const UNREAD = {
  budget: [`the page's font files came to more than the ${inMB(FONT_BYTES)} easyfontkit reads of one page`, `the page's font files came to more than the ${inMB(FONT_BYTES)} easyfontkit reads of one page`],
  big: [`it is larger than the ${inMB(FILE_BYTES)} easyfontkit reads of one font file`, `each is larger than the ${inMB(FILE_BYTES)} easyfontkit reads of one font file`],
};

module.exports = { FONT_BYTES, FILE_BYTES, UNREAD, inMB };
