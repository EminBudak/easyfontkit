"use strict";

// How a font is licensed, as far as the font and where it came from say.
// Open means the font says so itself (SIL Open Font License, Apache, Ubuntu
// Font Licence and the like), comes from an open library (Google Fonts,
// Fontsource, Bunny Fonts), or is a family Fontsource lists under an open
// license. Commercial means the font or the service it comes from says it
// is licensed: license text that sells or restricts it, a foundry's license
// link, a paid font service, or embedding bits that only allow preview and
// print. Anything else is unknown. The kit saves every file either way and
// says which is which; what to do with them is the reader's call.

const OPEN_TEXT = [
  [/open font licen[cs]e|scripts\.sil\.org\/ofl|openfontlicense\.org|\bOFL\b/i, "SIL Open Font License"],
  [/apache licen[cs]e|apache\.org\/licenses/i, "Apache License"],
  [/ubuntu font licen[cs]e|font\.ubuntu\.com\/licen[cs]e/i, "Ubuntu Font Licence"],
  [/creativecommons\.org\/publicdomain\/zero|\bCC0\b|public domain/i, "public domain dedication"],
  [/\bMIT licen[cs]e\b|opensource\.org\/licenses\/mit/i, "MIT License"],
];
const RESTRICTING_TEXT = /\bsold\b|licensee|commercial|\beula\b|end[ -]user licen[cs]e|not to be used|not for (re)?distribution|may not be|licen[cs]e agreement|purchas/i;
const OPEN_LIBRARIES = { google: "Google Fonts", fontsource: "Fontsource", bunny: "Bunny Fonts" };
const PAID_SERVICES = { adobe: "Adobe Fonts", monotype: "Monotype Fonts", typography: "Typography.com" };
const OPEN_IDS = {
  "OFL-1.1": "SIL Open Font License 1.1",
  "Apache-2.0": "Apache License 2.0",
  "UFL-1.0": "Ubuntu Font Licence 1.0",
  "CC0-1.0": "public domain dedication (CC0)",
  MIT: "MIT License",
  Unlicense: "Unlicense",
};
// Fontsource writes some license ids in lower case ("mit").
const openId = (id) => OPEN_IDS[Object.keys(OPEN_IDS).find((known) => known.toLowerCase() === String(id || "").toLowerCase())] || "";

// A licensee's own license number, which some foundries write into the
// file and its license link, is left out of what the kit says: it names the
// site's purchase, not the font's terms.
const LICENSE_ID = /\b(?:license|licence|order|customer|serial|invoice)\s*(?:id|no\.?|number|#)\s*[:#]?\s*[A-Z0-9][A-Z0-9-]{5,}\b\.?\s*/gi;
const KEY_LIKE = /\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,}){2,}\b/i;

function redact(text) {
  return String(text || "")
    .replace(LICENSE_ID, "")
    .replace(new RegExp(KEY_LIKE.source, "gi"), "…")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function redactUrl(url) {
  const text = String(url || "").trim();
  const bare = text.split(/[?#]/)[0];
  const at = bare.search(KEY_LIKE);
  return at === -1 ? bare : bare.slice(0, at);
}

// Where a font file was served from, by its address.
function sourceOf(url, pageUrl) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "inline";
  }
  if (!host) return "inline";
  if (/(^|\.)(fonts\.gstatic\.com|fonts\.googleapis\.com)$/.test(host)) return "google";
  if (/(^|\.)fonts\.bunny\.net$/.test(host)) return "bunny";
  if (host === "cdn.jsdelivr.net" && /\/(fontsource|npm\/@fontsource)\//.test(url)) return "fontsource";
  if (/(^|\.)typekit\.(net|com)$/.test(host)) return "adobe";
  if (/(^|\.)fonts\.(net|com)$|(^|\.)fast\.fonts\.net$/.test(host)) return "monotype";
  if (/(^|\.)cloud\.typography\.com$/.test(host)) return "typography";
  // The site's own domain, or a CDN named after it (stripecdn.com for
  // stripe.com).
  try {
    const site = new URL(pageUrl).hostname.toLowerCase().split(".").slice(-2).join(".");
    const label = site.split(".")[0];
    if (host === site || host.endsWith(`.${site}`) || (label.length >= 4 && host.split(".").slice(-2)[0].includes(label))) return "self-hosted";
  } catch {
    // No page to compare with.
  }
  return "third-party";
}

const SOURCE_NAMES = { ...OPEN_LIBRARIES, ...PAID_SERVICES, "self-hosted": "the site itself", inline: "a data URL in the page", system: "the visitor's system" };

const short = (text, n = 90) => {
  const one = String(text || "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1).trim()}…` : one;
};

// font: what sfnt.describeFont read from a file (or {} for a system font).
// source: sourceOf() for the file. listed: the Fontsource index entry for
// the family, when there is one.
function licenseOf(raw, { source = "", listed = null } = {}) {
  const font = { ...raw, license: redact(raw.license), licenseUrl: redactUrl(raw.licenseUrl) };
  const maker = font.manufacturer || "";
  const text = `${font.license || ""} ${font.licenseUrl || ""}`;
  for (const [pattern, name] of OPEN_TEXT) {
    if (pattern.test(text)) return { status: "open", name, url: font.licenseUrl || "", maker, basis: `the font file names the ${name}` };
  }
  if (RESTRICTING_TEXT.test(font.license || "")) {
    return { status: "commercial", name: "", url: font.licenseUrl || "", maker, basis: `the font file says "${short(font.license)}"` };
  }
  if (font.licenseUrl) {
    return { status: "commercial", name: "", url: font.licenseUrl, maker, basis: "the font file points to its maker's license" };
  }
  if (OPEN_LIBRARIES[source]) {
    return { status: "open", name: (listed && openId(listed.license)) || "", url: "", maker, basis: `${OPEN_LIBRARIES[source]} serves it, and it serves only open fonts` };
  }
  if (PAID_SERVICES[source]) return { status: "commercial", name: "", url: "", maker, basis: `${PAID_SERVICES[source]} serves it, under the site's own subscription` };
  if (font.embedding === "restricted" || font.embedding === "preview and print") {
    return { status: "commercial", name: "", url: "", maker, basis: `the font file allows only ${font.embedding === "restricted" ? "restricted" : "preview and print"} embedding` };
  }
  if (listed && openId(listed.license)) {
    return { status: "open", name: openId(listed.license), url: "", maker, basis: `Fontsource lists ${listed.family} under the ${openId(listed.license)}` };
  }
  if (/all rights reserved/i.test(font.copyright || "")) {
    return { status: "commercial", name: "", url: "", maker, basis: "the font file's copyright notice reserves all rights" };
  }
  return { status: "unknown", name: "", url: "", maker, basis: "nothing in the file or where it came from says how it is licensed" };
}

module.exports = { licenseOf, sourceOf, redact, redactUrl, SOURCE_NAMES };
