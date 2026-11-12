"use strict";

// The most easyfontkit reads of a page, and how the notes say why a font
// file was not read.

// The most easyfontkit keeps of the bodies of a page's font files, those
// the page loads over the network and those it gives as data: addresses,
// all told, as much as the browser keeps of all it loads for a page (see
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

// The most a run reads of the text of a page's style sheets, all told, and
// of the @font-face rules its CSS object model gives: no site's CSS comes
// near.
const CSS_BYTES = 64 * 1024 * 1024;

const inMB = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

// Why a font file was not read, as a note says it of one file and of
// several: past what a run keeps of a page's (budget), larger than it reads
// of one (big), or no longer held by the browser when it was asked for
// (dropped), as the browser keeps what a page loads up to a buffer of its
// own and lets go of the oldest past that.
const UNREAD = {
  budget: [`the page's font files came to more than the ${inMB(FONT_BYTES)} easyfontkit reads of one page`, `the page's font files came to more than the ${inMB(FONT_BYTES)} easyfontkit reads of one page`],
  big: [`it is larger than the ${inMB(FILE_BYTES)} easyfontkit reads of one font file`, `each is larger than the ${inMB(FILE_BYTES)} easyfontkit reads of one font file`],
  dropped: [
    "the browser no longer held it when easyfontkit asked for it, which can happen when a page's font files come at the same moment",
    "the browser no longer held them when easyfontkit asked for them, which can happen when a page's font files come at the same moment",
  ],
};

module.exports = { FONT_BYTES, FILE_BYTES, CSS_BYTES, UNREAD, inMB };
