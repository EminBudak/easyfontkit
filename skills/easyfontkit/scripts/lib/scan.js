"use strict";

// What a page draws its text with. The page is opened with the network
// recorded, so every font file it loads is kept as the browser received it,
// with no second download. Chrome then says which face it really drew
// headings, body text, buttons and code with: the font it picked from the
// CSS font stack, not the stack itself. The @font-face rules are read too,
// to tie a CSS family to its files when a file hides its own names.

const crypto = require("crypto");
const { navigate, currentAddress, triedSoFar, handedOut, GUARD_WORLD } = require("./chrome");
const { describeFont } = require("./sfnt");
const { timeLeft, sleep } = require("./time");
const { FONT_BYTES, FILE_BYTES, CSS_BYTES, UNREAD, inMB } = require("./limits");

// The second selector of a role is tried only when the first finds no text:
// a page built from divs has no p, and a heading can be a styled div.
// Chrome counts the text of an element and of its children's children, so
// the inner elements of headings and buttons are asked too: a button's
// label often sits three levels down.
const BUTTONS = "button, [role=button], input[type=submit], input[type=button], a[class*=button i], a[class*=btn i]";
const ROLES = [
  ["heading", ["h1, h2, h3, h1 *, h2 *, h3 *", "h4, [role=heading], [class*=headline i], [class*=heading i], [class*=title i]"]],
  ["body", ["p, li, dd, blockquote, td", "span, div, a"]],
  ["button", [`${BUTTONS}, ${BUTTONS.split(", ").filter((selector) => !selector.startsWith("input")).map((selector) => `${selector} *`).join(", ")}`]],
  ["code", ["pre, code, kbd, samp"]],
];
const NODES_WITH_TEXT = 24;
const NODES_TRIED = 80;

// A bot check served instead of the page (a CAPTCHA, "Just a moment…").
const CHALLENGE_TITLE = /human verification|just a moment|attention required|access denied|verify you are human|are you a robot|security check|checking your browser|pardon our interruption|ddos-guard|one more step|request blocked|captcha/i;

const sizeText = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : inMB(bytes));

// A font the page gives as a data: address is known by a key, a digest of
// the whole address, wherever it comes up: in the browser's request for it,
// in its report of the faces it loaded and in a style sheet's text. The
// address itself, which can be megabytes long, is not kept. The notes name
// such a font by its media type and its size (dataLabel).
const dataKey = (url) => `data:sha1,${crypto.createHash("sha1").update(String(url)).digest("hex")}`;
// A print of a data: address: its length and its first and last 64
// characters, each character that could end the address in a src written
// as _. The rules read from the page's CSS object model give a data:
// address by its print (cssomRules), as a page served over plain http has
// no digest to make of one. record() keeps the print of each font the
// browser asked for, so such a rule is tied to its font by it. It runs in
// the page as well, as it is written.
const dataPrint = (url) => `data:easyfontkit,${url.length},${[url.slice(0, 64), url.slice(-64)].map((part) => part.replace(/[^\w+/=;:,.%-]/g, "_")).join(",")}`;
function dataLabel(url, bytes) {
  const type = (/^data:([^,;]{0,80})/i.exec(url) || [])[1] || "";
  return `a font the page gave as a data: address (${/^[\w.+-]+\/[\w.+-]+$/.test(type) ? `${type.toLowerCase()}, ` : ""}${sizeText(bytes)})`;
}
// How many bytes a data: address decodes to, at most, before it is decoded.
function dataBytes(url) {
  const comma = url.indexOf(",");
  if (comma === -1) return 0;
  const length = url.length - comma - 1;
  return /;base64$/i.test(url.slice(0, comma)) ? Math.ceil((length * 3) / 4) : length;
}

// Every request's addresses, redirects included, and each font file's body
// as soon as it has arrived: read later, a long page's pictures can push it
// out of the browser's buffer. Bodies are kept up to `most` bytes in all: a
// file whose body would take them past it, with those still coming, is not
// fetched, or is let go of as it comes, and is marked left, and one larger
// than `one` is not fetched and is marked big. A body the browser no longer
// holds when it is asked for is marked dropped: the browser lets go of the
// oldest it keeps once what a page loaded passes its buffer, which font
// files that come at the same moment can do before they are asked for. A
// font the page gives as a data: address is decoded once, as the browser
// asks for it, within the same `most` and `one` (inline).
function record(cdp, most = FONT_BYTES, one = FILE_BYTES) {
  const addresses = new Map();
  const fonts = new Map();
  const faces = [];
  const sheets = new Map();
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
    if (request && !String(request.url).startsWith("data:")) addresses.set(requestId, [...(addresses.get(requestId) || []), request.url]);
  });
  cdp.on("Network.responseReceived", ({ requestId, type, response }) => {
    if (type !== "Font" || !response || String(response.url).startsWith("data:")) return;
    fonts.set(requestId, { urls: [...new Set([...(addresses.get(requestId) || []), response.url])], status: response.status, body: null, size: 0 });
  });
  // How large each font file's body is as it comes, unpacked.
  cdp.on("Network.dataReceived", ({ requestId, dataLength = 0 }) => {
    const font = fonts.get(requestId);
    if (font) font.size += dataLength;
  });
  // The bytes of the bodies kept, and of those fetched and not come yet, as
  // large as each has come, or as what came over the network for it when
  // the browser told less. A file that takes them past `most` is not
  // fetched.
  let kept = 0;
  let coming = 0;
  cdp.on("Network.loadingFinished", ({ requestId, encodedDataLength = 0 }) => {
    const font = fonts.get(requestId);
    if (!font) return;
    font.finished = true;
    const size = Math.max(font.size, encodedDataLength);
    if (size > one) {
      font.left = "big";
      return;
    }
    if (kept + coming + size > most) {
      font.left = "budget";
      return;
    }
    coming += size;
    font.body = cdp
      .send("Network.getResponseBody", { requestId })
      .then(({ body, base64Encoded }) => {
        const bytes = Buffer.byteLength(body, base64Encoded ? "base64" : "utf8");
        if (kept + bytes > most) {
          font.left = "budget";
          return null;
        }
        kept += bytes;
        return Buffer.from(body, base64Encoded ? "base64" : "utf8");
      })
      .catch((err) => {
        // The browser's answer, not a call that got none or a tab that has
        // gone, which end the run. A file the server answered with an error
        // is noted with that error (readFiles).
        if (!err.timedOut && !err.closed && !err.crashed && font.status < 400) font.left = "dropped";
        return null;
      })
      .finally(() => (coming -= size));
  });
  // The fonts the page gives as data: addresses that the browser asked for,
  // by their keys: { label, body } each, or what kept it from being read
  // (left). One the browser never asked for, as a fallback after a font it
  // took, is not among them, as a file it never asked for is not.
  const inline = new Map();
  const inlineFont = (url) => {
    const key = dataKey(url);
    if (inline.has(key)) return key;
    const bytes = dataBytes(url);
    const font = { label: dataLabel(url, bytes), body: null, left: "", print: dataPrint(url) };
    inline.set(key, font);
    if (bytes > one) font.left = "big";
    else if (kept + coming + bytes > most) font.left = "budget";
    else {
      font.body = decodeDataUrl(url);
      if (font.body) {
        kept += font.body.length;
        font.label = dataLabel(url, font.body.length);
      }
    }
    return key;
  };
  cdp.on("Network.requestWillBeSent", ({ type, request }) => {
    if (type === "Font" && request && String(request.url).startsWith("data:")) inlineFont(request.url);
  });
  // The address of every font file the browser asked for, redirects
  // included, also of one whose answer has not come: one that is not among
  // the files read did not load while the page was read.
  const asked = new Set();
  cdp.on("Network.requestWillBeSent", ({ type, request }) => {
    if (type === "Font" && request && !String(request.url).startsWith("data:")) asked.add(request.url);
  });
  // The font files the browser refused to load, by the address the page
  // asked for, with why: one from another site whose server does not let
  // this page use it (CORS), or one the page's own Content-Security-Policy
  // keeps out. The browser refuses them again on every visit, so another
  // run does not get them either.
  const refused = new Map();
  cdp.on("Network.loadingFailed", ({ requestId, type, corsErrorStatus, blockedReason }) => {
    const [url] = addresses.get(requestId) || [];
    if (type !== "Font" || !url) return;
    const why = corsErrorStatus && corsErrorStatus.corsError ? `CORS error: ${corsErrorStatus.corsError}` : blockedReason ? `blocked: ${blockedReason}` : "";
    if (why) refused.set(requestId, { url, why, reason: `the browser refused it (${why})` });
  });
  // The status of each request's last answer as the network got it, also
  // of one the browser then refused: a server's error page often comes
  // without the header CORS asks for, and then the error is what kept the
  // file out, an answer another run may not get. Chrome can say this after
  // it has said the request failed.
  const statuses = new Map();
  cdp.on("Network.responseReceivedExtraInfo", ({ requestId, statusCode }) => {
    if (statusCode) statuses.set(requestId, statusCode);
  });
  // The faces the browser loaded, one given as a data: address by its key.
  cdp.on("CSS.fontsUpdated", ({ font }) => font && faces.push(String(font.src || "").startsWith("data:") ? { ...font, src: inlineFont(font.src) } : font));
  cdp.on("CSS.styleSheetAdded", ({ header }) => header && header.origin === "regular" && sheets.set(header.styleSheetId, header));
  // The tab's own page as the server answered it: the last response its
  // main frame got, after any redirects, so a script that moves the page on
  // counts too. The frames inside a page get documents of their own, and a
  // blob: address a page made for itself is no answer of a server's and has
  // no host to name the kit by.
  const page = { frame: "", status: 0, url: "", shown: "", first: "", requested: "", failed: null };
  cdp.on("Network.responseReceived", ({ frameId, type, response }) => {
    if (type === "Document" && response && page.frame && frameId === page.frame && /^https?:/i.test(response.url)) Object.assign(page, { status: response.status, url: response.url });
  });
  // The address the tab's own page was first asked from, as Chrome writes
  // it, and the one it was last asked from, each redirect's included, so a
  // redirect to an address that cannot be opened or does not answer is
  // named. Chrome writes some characters otherwise than Node does, like a |
  // in a path, so whether the page moved on is told against first.
  cdp.on("Network.requestWillBeSent", ({ frameId, type, request }) => {
    if (type !== "Document" || !request || !page.frame || frameId !== page.frame) return;
    page.first = page.first || request.url;
    page.requested = request.url;
  });
  // A page that moves itself on, by a script or a meta refresh, to an
  // address that cannot be opened at all, like a host that does not resolve
  // or a closed port, gets no response: the tab shows the browser's own
  // error page for that address instead (failed), until a page that loads
  // takes its place. The reason is the first one its load gave: the browser
  // tries the address again a second later and then drops that try as
  // canceled, which says nothing.
  const errors = new Map();
  cdp.on("Network.loadingFailed", ({ requestId, type, errorText, canceled }) => {
    if (type === "Document" && !canceled && errorText && !errors.has(requestId)) errors.set(requestId, errorText);
  });
  // The last web address the tab showed goes with it: a response alone says
  // less, as one that was a download, which the browser refuses, leaves the
  // tab where it was.
  cdp.on("Page.frameNavigated", ({ frame }) => {
    if (!frame || !page.frame || frame.id !== page.frame) return;
    page.failed = frame.unreachableUrl ? { url: frame.unreachableUrl, error: errors.get(frame.loaderId) || "" } : null;
    if (/^https?:/i.test(frame.url)) page.shown = frame.url;
  });
  // The style sheets the tab's own page has asked for and not got yet: the
  // browser draws nothing of a page until those in its head have come.
  const due = new Map();
  cdp.on("Network.requestWillBeSent", ({ requestId, frameId, type, request }) => {
    if (type === "Stylesheet" && request && page.frame && frameId === page.frame) due.set(requestId, request.url);
  });
  const arrived = ({ requestId }) => due.delete(requestId);
  cdp.on("Network.loadingFinished", arrived);
  cdp.on("Network.loadingFailed", arrived);
  // The addresses that are not web addresses, as mailto:, that the page or
  // a frame of it tried to open, as the browser tells them: a move a script,
  // a refresh, a form or a link asked for (asked), which the guard each
  // document gets cancels, one the browser began to go to (started), as the
  // first address of a frame or one a frame's page redirected to, and a
  // window the page asked for (window), which the browser does not open
  // without a click. A frame of another site tells of its own, and of its
  // frames' redirects, on a session of its own (openPage). A frame at such
  // an address tells of it twice, and a page can try one any number of
  // times, so each address is kept once with each way it went, up to 50
  // addresses, and triedMore says there were more.
  const tried = [];
  const triedAt = new Set();
  const ways = new Set();
  let triedMore = false;
  const keep = (how) => ({ url }) => {
    if (!handedOut(url)) return;
    const address = String(url).slice(0, 300);
    if (!triedAt.has(address)) {
      if (triedAt.size >= 50) return void (triedMore = true);
      triedAt.add(address);
    }
    if (ways.has(`${how}\u0000${address}`)) return;
    ways.add(`${how}\u0000${address}`);
    tried.push({ url: address, how });
  };
  const listen = (session) => {
    session.on("Page.frameScheduledNavigation", keep("asked"));
    session.on("Page.frameRequestedNavigation", keep("asked"));
    session.on("Page.frameStartedNavigating", keep("started"));
    session.on("Page.windowOpen", keep("window"));
    session.on("Network.requestWillBeSent", ({ type, request, redirectResponse }) => {
      if (type === "Document" && redirectResponse && request) keep("started")(request);
    });
  };
  listen(cdp);
  if (cdp.onFrame) cdp.onFrame(listen);
  return {
    fonts,
    inline,
    asked,
    refused,
    statuses,
    faces,
    sheets,
    page,
    due,
    tried,
    get triedMore() {
      return triedMore;
    },
  };
}

async function evaluate(cdp, expression, timeoutMs = 10_000, contextId = 0) {
  const { result = {} } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, timeoutMs).catch(() => ({}));
  return result.value;
}

// The id of a world of easyfontkit's own in the page the tab shows now, the
// one the guard runs in (see chrome.js), or 0 when there is none to be had,
// as between two documents. The page's own scripts cannot reach it: what
// runs there has JavaScript's own String, Object and Array, which a page
// can replace in its own world, so a read that keeps only so much of what
// the page holds, as of its rules or of a node's text, keeps to that there.
async function ownWorld(cdp, frameId) {
  const { executionContextId = 0 } = await cdp.send("Page.createIsolatedWorld", { frameId, worldName: GUARD_WORLD }, 10_000).catch(() => ({}));
  return executionContextId;
}

// What an expression gives in easyfontkit's own world in the page of the
// tab's own frame, or nothing when it has none: a page can give its
// document a getter of its own, or replace a built-in such as
// Array.prototype.map, only in its own world.
async function ownEvaluate(cdp, frameId, expression) {
  const world = await ownWorld(cdp, frameId);
  return world ? evaluate(cdp, expression, 10_000, world) : undefined;
}

const fontsReady = (cdp) => evaluate(cdp, "Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]).then(() => true)");

async function metrics(cdp) {
  const m = await cdp.send("Page.getLayoutMetrics");
  const viewport = m.cssLayoutViewport || m.layoutViewport || {};
  const visual = m.cssVisualViewport || m.visualViewport || {};
  const content = m.cssContentSize || m.contentSize || {};
  return {
    width: Math.max(1, Math.floor(viewport.clientWidth || 0)),
    viewportHeight: Math.max(1, Math.floor(viewport.clientHeight || 0)),
    scrollY: Math.max(0, Math.floor(visual.pageY || 0)),
    height: Math.max(1, Math.ceil(content.height || 0)),
  };
}

// A step of the scroll is taken once the page has drawn: one that a page
// has not taken in this long, it does not take, as with a page that waits
// for a style sheet that never comes, or one whose scripts hold it.
const WHEEL_WAIT = 10_000;
const wheel = (cdp, x, y, deltaY) => cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY }, WHEEL_WAIT);

// Down a screen at a time, so sections that render only when scrolled to
// (and the fonts they use, often the code font) load. If the page does not
// move, the pointer may sit on an inner scroller: retry once from the left
// edge.
async function walk(cdp) {
  let m = await metrics(cdp);
  const step = Math.max(200, Math.floor(m.viewportHeight * 0.8));
  const midY = Math.floor(m.viewportHeight / 2);
  for (let i = 0; i < 40 && timeLeft() > 30_000; i++) {
    if (m.scrollY + m.viewportHeight >= m.height - 2) break;
    const before = m.scrollY;
    await wheel(cdp, Math.floor(m.width / 2), midY, step);
    await sleep(250);
    m = await metrics(cdp);
    if (m.scrollY === before) {
      await wheel(cdp, 8, midY, step);
      await sleep(250);
      m = await metrics(cdp);
      if (m.scrollY === before) break;
    }
  }
  await sleep(600);
  await wheel(cdp, 8, midY, -(m.height + m.viewportHeight));
  await sleep(400);
}

// The text Chrome counts the glyphs of for a node: that of its own text
// nodes and of its children's, as it is laid out, with each run of white
// space one space, or the label of an input button, its value, which no
// text node holds. Read for a node drawn in part with a font of the
// visitor's own, as one a web font has no glyphs for: { text, length },
// the text cut to 20000 characters and how long it was. The page hands
// back the text alone, however many children the node has, read in
// easyfontkit's own world (world), or no text when it has none. A page
// that holds the call up, as its own scripts can, is not asked again in
// this run: its text is not read, and the note on it is worded as before.
const TEXT_KEPT = 20_000;
const TEXT_WAIT = 5_000;
const textHeld = new WeakSet();
const OWN_TEXT = `function (kept) {
  let text = "";
  const own = (node) => { for (const child of node.childNodes) if (child.nodeType === 3) text += child.data; };
  if (this.localName === "input") text = String(this.value || "");
  else {
    own(this);
    for (const child of this.children) own(child);
  }
  text = text.replace(/\\s+/g, " ").trim();
  return [text.slice(0, kept), text.length];
}`;
async function textOf(cdp, nodeId, world) {
  const none = { text: "", length: 0 };
  if (textHeld.has(cdp) || !world) return none;
  const held = (err) => {
    if (err && err.timedOut) textHeld.add(cdp);
    return {};
  };
  const { object } = await cdp.send("DOM.resolveNode", { nodeId, executionContextId: world }, TEXT_WAIT).catch(held);
  if (!object || !object.objectId) return none;
  const { result = {} } = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: OWN_TEXT, arguments: [{ value: TEXT_KEPT }], returnByValue: true }, TEXT_WAIT).catch(held);
  await cdp.send("Runtime.releaseObject", { objectId: object.objectId }, TEXT_WAIT).catch(held);
  const [text, length] = Array.isArray(result.value) ? result.value : [];
  return typeof text === "string" && Number.isFinite(length) ? { text: text.slice(0, TEXT_KEPT), length: Math.max(length, text.length) } : none;
}

// The faces Chrome drew a role's text with, most glyphs first, with the
// weights, styles and CSS stacks that text asked for. A font of the
// visitor's own also keeps, for each node it drew, the text Chrome counted
// there and how many of its glyphs the visitor's own fonts drew (nodes).
// The nodes are read while the run has 15 s left: `cut` says that its time
// ran out before every node there was to read had been read. Their text is
// read in easyfontkit's own world (world).
async function readRole(cdp, rootId, selector, world) {
  const { nodeIds = [] } = await cdp.send("DOM.querySelectorAll", { nodeId: rootId, selector }).catch(() => ({}));
  const faces = new Map();
  let withText = 0;
  let cut = false;
  for (const nodeId of nodeIds.slice(0, NODES_TRIED)) {
    if (withText >= NODES_WITH_TEXT) break;
    if (timeLeft() < 15_000) {
      cut = true;
      break;
    }
    const { fonts = [] } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId }).catch(() => ({}));
    const drawn = fonts.filter((font) => font.glyphCount > 0);
    if (!drawn.length) continue;
    withText++;
    const { computedStyle = [] } = await cdp.send("CSS.getComputedStyleForNode", { nodeId }).catch(() => ({}));
    const css = (name) => ((computedStyle.find((property) => property.name === name) || {}).value || "").trim();
    const stack = css("font-family");
    const weight = css("font-weight") || "400";
    const italic = /italic|oblique/.test(css("font-style"));
    const system = drawn.filter((font) => !font.isCustomFont).reduce((sum, font) => sum + font.glyphCount, 0);
    const read = system ? await textOf(cdp, nodeId, world) : null;
    for (const font of drawn) {
      const key = `${font.isCustomFont ? "web" : "system"}\u0000${font.familyName}\u0000${font.postScriptName || ""}`;
      const face = faces.get(key) || {
        familyName: font.familyName || "",
        postScriptName: font.postScriptName || "",
        custom: Boolean(font.isCustomFont),
        glyphs: 0,
        italicGlyphs: 0,
        weights: {},
        stacks: {},
        ...(font.isCustomFont ? {} : { nodes: [] }),
      };
      face.glyphs += font.glyphCount;
      if (face.nodes) face.nodes.push({ ...read, system });
      if (italic) face.italicGlyphs += font.glyphCount;
      face.weights[weight] = (face.weights[weight] || 0) + font.glyphCount;
      face.stacks[stack] = (face.stacks[stack] || 0) + font.glyphCount;
      faces.set(key, face);
    }
  }
  return { faces: [...faces.values()].sort((a, b) => b.glyphs - a.glyphs), cut };
}

// The faces of each role, and the roles the run's time ran out before any
// text of was read (cut): the time a slow browser or a font that never
// comes took, which a role with no text does not tell from one never read.
// frameId is the tab's own frame, in whose page easyfontkit's own world
// reads the text of nodes.
async function readRoles(cdp, frameId) {
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const world = await ownWorld(cdp, frameId);
  const roles = {};
  const cut = [];
  for (const [role, selectors] of ROLES) {
    for (const selector of selectors) {
      const read = await readRole(cdp, root.nodeId, selector, world);
      if (read.faces.length) {
        roles[role] = read.faces;
        break;
      }
      if (read.cut) {
        cut.push(role);
        break;
      }
    }
  }
  return { roles, cut };
}

// A declaration list split on the semicolons outside quotes and brackets: a
// data URL in src has its own.
function declarations(body) {
  const out = {};
  let depth = 0;
  let quote = "";
  let start = 0;
  const take = (end) => {
    const text = body.slice(start, end);
    const colon = text.indexOf(":");
    if (colon > 0) out[text.slice(0, colon).trim().toLowerCase()] = text.slice(colon + 1).trim();
    start = end + 1;
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) take(i);
  }
  take(body.length);
  return out;
}

const unquote = (text) => String(text || "").trim().replace(/^(['"])(.*)\1$/s, "$2").trim();

// A request never carries the address's #fragment.
const bare = (address) => String(address).replace(/#.*$/s, "");

function resolve(url, base) {
  try {
    return new URL(url, base || undefined).href;
  } catch {
    return "";
  }
}

// The src addresses of a @font-face declaration, absolute. A quoted address
// is matched with no choice inside the repeat, so one of megabytes, as a
// font given as a data: address can be, does not run the regular expression
// engine out of stack. An address without quotes stops at a quote or a (,
// which CSS keeps out of one, so a src of many url( openings that never
// close is read in a moment, where each was tried to the end of the src.
const SRC_URL = /url\(\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^)\s"'(]*))\s*\)/gi;
function srcUrls(src, base) {
  return [...String(src || "").matchAll(SRC_URL)]
    .map((m) => (m[1] ?? m[2] ?? m[3] ?? "").trim())
    .filter(Boolean)
    .map((url) => (url.startsWith("data:") ? url : resolve(url, base)))
    .filter(Boolean);
}

// The @font-face rules in a style sheet's text. Its comments are cut and
// the rules' blocks found by scans that stop at the first comment or block
// that does not close, as nothing closes after it, so a sheet of many
// openings that never close is read in a moment, where a regular expression
// tried each of them to the end of the sheet, for hours on one of 64 MB.
function fontFaceRules(text, base) {
  const rules = [];
  const all = String(text || "");
  let clean = "";
  for (let at = 0; ; ) {
    const open = all.indexOf("/*", at);
    const close = open === -1 ? -1 : all.indexOf("*/", open + 2);
    if (close === -1) {
      clean += all.slice(at);
      break;
    }
    clean += all.slice(at, open);
    at = close + 2;
  }
  const start = /@font-face\s*\{/gi;
  for (let found = start.exec(clean); found; found = start.exec(clean)) {
    const end = clean.indexOf("}", start.lastIndex);
    if (end === -1) break;
    const d = declarations(clean.slice(start.lastIndex, end));
    start.lastIndex = end + 1;
    const family = unquote(d["font-family"]);
    const urls = srcUrls(d.src, base);
    if (family && urls.length) rules.push({ family, weight: d["font-weight"] || "400", style: d["font-style"] || "normal", unicodeRange: d["unicode-range"] || "", urls });
  }
  return rules;
}

// The same rules as the page's own CSS object model has them: style sheets
// a script builds rule by rule (CSS-in-JS) have no text to read, and other
// sites' sheets have a text but no readable rules, so both are read. Run in
// easyfontkit's own world in the page (ownWorld), with the most characters
// it gives back, past which it stops, and dataPrint. A data: address in a
// src stands there as its print: the browser's request for such a font, and
// its report of the face it loaded, tell of it (record), and the address
// itself can be megabytes long.
function cssomRules(most, print) {
  const out = [];
  let size = 0;
  const lean = (src) => src.replace(/url\(\s*(?:"(data:[^"\\]*(?:\\.[^"\\]*)*)"|'(data:[^'\\]*(?:\\.[^'\\]*)*)'|(data:[^)\s]*))\s*\)/gi, (whole, double, single, bare) => `url("${print(double ?? single ?? bare)}")`);
  const visit = (rules, base, depth) => {
    if (depth > 8) return;
    for (const rule of rules) {
      if (size > most) return;
      if (rule instanceof CSSFontFaceRule) {
        const get = (name) => rule.style.getPropertyValue(name);
        const one = { family: get("font-family"), src: lean(get("src")), weight: get("font-weight"), style: get("font-style"), unicodeRange: get("unicode-range"), base };
        size += Object.values(one).reduce((sum, value) => sum + String(value).length, 0);
        if (size <= most) out.push(one);
      } else if (rule instanceof CSSImportRule) {
        try {
          if (rule.styleSheet) visit(rule.styleSheet.cssRules, rule.styleSheet.href || base, depth + 1);
        } catch {}
      } else if (rule.cssRules) {
        visit(rule.cssRules, base, depth + 1);
      }
    }
  };
  for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
    try {
      visit(sheet.cssRules, sheet.href || location.href, 0);
    } catch {}
  }
  return out;
}

// A rule's data: addresses by their keys, and those given by their prints
// by the keys of the fonts with those prints (byPrint).
const keyed = (rule, byPrint = new Map()) => ({ ...rule, urls: rule.urls.map((url) => byPrint.get(url) || (url.startsWith("data:") ? dataKey(url) : url)) });

// The text of each style sheet is read while the text read so far stays
// within CSS_BYTES, as its length tells before it is read. A sheet a script
// built (new CSSStyleSheet) is not: the page can give it new text, of any
// length, once the browser has told its length, and the browser then gives
// that text. Its rules are read from the CSS object model, as those of a
// sheet past CSS_BYTES are. A sheet or a rule that cannot be read is passed
// over. A data: address the CSS object model gives by its print is the
// font the browser asked for with that print, by its key (inline, from
// record). The CSS object model is read in easyfontkit's own world in the
// page of the tab's own frame (frameId), and not at all when it has none.
async function readRules(cdp, sheets, pageUrl, inline = new Map(), frameId = "") {
  const rules = [];
  let read = 0;
  for (const [styleSheetId, header] of sheets) {
    if (timeLeft() < 15_000) break;
    if (header.isConstructed) continue;
    const length = Number(header.length) || 0;
    if (read + length > CSS_BYTES) continue;
    read += length;
    const { text = "" } = await cdp.send("CSS.getStyleSheetText", { styleSheetId }).catch(() => ({}));
    try {
      if (/@font-face/i.test(text)) rules.push(...fontFaceRules(text, header.sourceURL || pageUrl).map((rule) => keyed(rule)));
    } catch {
      // Passed over.
    }
  }
  const byPrint = new Map([...inline].map(([key, font]) => [font.print, key]));
  const world = await ownWorld(cdp, frameId);
  for (const rule of (world && (await evaluate(cdp, `(${cssomRules})(${CSS_BYTES}, ${dataPrint})`, 10_000, world))) || []) {
    try {
      const family = unquote(rule.family);
      const urls = srcUrls(rule.src, rule.base);
      if (family && urls.length) rules.push(keyed({ family, weight: rule.weight || "400", style: rule.style || "normal", unicodeRange: rule.unicodeRange || "", urls }, byPrint));
    } catch {
      // Passed over.
    }
  }
  const seen = new Set();
  return rules.filter((rule) => {
    const key = `${rule.family}\u0000${rule.weight}\u0000${rule.style}\u0000${rule.urls.join(" ")}`;
    return !seen.has(key) && seen.add(key);
  });
}

function decodeDataUrl(url) {
  const m = /^data:([^,]*?),(.*)$/s.exec(url);
  if (!m) return null;
  try {
    return /;base64$/i.test(m[1]) ? Buffer.from(m[2], "base64") : Buffer.from(decodeURIComponent(m[2]), "latin1");
  } catch {
    return null;
  }
}

// The font files, each once: the same file can be asked for twice, under
// two addresses or as a data: address. A file the browser refused is
// skipped with why, as one its server answered with an error or with no
// bytes at all is, and with that error when its server answered it with
// one. One read all the same from that address, as by a preload the page
// made without crossorigin, which the browser does not hold to CORS, is in
// the kit and not skipped, and the refusal goes with it (refusedRead): the
// browser does not draw the page's text with it. The files whose bodies
// were not kept, as the page's font files came to more than a run keeps or
// the file to more than it reads of one, or the browser no longer held them
// (record), are given apart (unread), each with why (UNREAD). A font given
// as a data: address is known by its key, and its label names it in the
// notes. A body is let go of once it is read, so one that is not a usable
// font file is not held.
async function readFiles(fonts, inline = new Map(), refused = new Map(), statuses = new Map()) {
  const files = new Map();
  const skipped = [];
  const refusedRead = [];
  const unread = [];
  const add = (buffer, urls, label = urls[0] || "") => {
    const sha = crypto.createHash("sha1").update(buffer).digest("hex");
    const known = files.get(sha);
    if (known) return void known.urls.push(...urls.filter((url) => !known.urls.includes(url)));
    try {
      files.set(sha, { sha, urls: [...urls], buffer, font: describeFont(buffer) });
    } catch (err) {
      skipped.push({ url: urls[0] || "", label, reason: err.message });
    }
  };
  const left = (url, label, why) => unread.push({ url, label, why, reason: UNREAD[why][0] });
  for (const font of fonts.values()) {
    const body = font.body ? await font.body : null;
    font.body = null;
    const [url = ""] = font.urls;
    if (font.left) left(url, url, font.left);
    else if (body && body.length) add(body, font.urls);
    else if (font.status >= 400) skipped.push({ url, label: url, reason: `the server answered ${font.status}` });
    // A whole answer with no bytes in it, as another run gets too.
    else if (font.finished && body) skipped.push({ url, label: url, reason: "the server sent an empty file" });
  }
  for (const [key, font] of inline) {
    if (font.left) left(key, font.label, font.left);
    else if (font.body && font.body.length) add(font.body, [key], font.label);
    font.body = null;
  }
  const read = (url) => [...files.values()].some((file) => file.urls.includes(url));
  for (const [requestId, refusal] of refused) {
    if (read(refusal.url)) {
      if (!refusedRead.some((known) => known.url === refusal.url)) refusedRead.push({ url: refusal.url, why: refusal.why });
      continue;
    }
    if (skipped.some((skip) => skip.url === refusal.url)) continue;
    const status = statuses.get(requestId) || 0;
    skipped.push({ url: refusal.url, label: refusal.url, reason: status >= 400 ? `the server answered ${status}` : refusal.reason });
  }
  return { files: [...files.values()], skipped, refusedRead, unread };
}

// Opens the page and reads it: the faces of each role, every font file it
// loaded, the ones it could not use and why (skipped), the browser's
// refusals of files it read all the same (refusedRead), those it did not
// read, as the page's had come to more than a run keeps, the file to more
// than it reads of one or the browser no longer held it, each with its
// address or key, its label and why (unread), the addresses of every one
// the browser asked for and the keys of the fonts given as data: addresses
// it asked for (asked), with their labels (labels), its @font-face rules,
// the web fonts Chrome reports as loaded, the families document.fonts
// holds, the status and address the server answered the page with
// (answer), the address the page was first asked from as Chrome wrote it
// (first), the address a redirect or the page led on to that could not be
// opened or did not answer (failed), about:blank or the like when the page
// moved itself on to that (left), for a page that did not draw, so it could
// not be scrolled, the style sheet it waited for, if one had not come
// (stalled), the addresses that are not web addresses the page tried to
// open (tried) and whether it tried more than were kept (triedMore), and
// the roles the run's time ran out before any text of was read (cut).
// pageUrl is the address of the page the roles were read from, or the last
// web address the tab showed when it has moved on to about:blank or to a
// blob: address, so it is always a web address.
async function scanPage(cdp, url, log = () => {}) {
  const recorded = record(cdp);
  // The browser keeps what it loads for DevTools as base64, a third larger
  // than the file, so it is told to keep half as much again as a run reads
  // of one font file.
  await cdp.send("Network.enable", { maxTotalBufferSize: 200_000_000, maxResourceBufferSize: (FILE_BYTES * 3) / 2 });
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { frameTree } = await cdp.send("Page.getFrameTree");
  recorded.page.frame = frameTree.frame.id;
  const nothing = (pageUrl, found) => ({ pageUrl, first: recorded.page.first, answer: { status: recorded.page.status, url: recorded.page.url }, failed: null, left: "", stalled: null, title: "", challenge: "", roles: {}, cut: [], files: [], skipped: [], refusedRead: [], unread: [], rules: [], faces: [], loaded: [], asked: [], labels: new Map(), tried: [], ...found });
  log(`Opening ${url}`);
  let pageUrl;
  try {
    pageUrl = await navigate(cdp, url);
  } catch (err) {
    const { status, requested, first } = recorded.page;
    // An error status with no page of its own makes Chrome show its own
    // error page and give a net:: code, which says less than the status.
    if (status >= 400) return nothing(url);
    // A redirect that led to an address that could not be opened, or whose
    // server did not answer: that address failed, not the one asked, which
    // answered.
    if ((err.errorText || err.noAnswer) && requested && first && bare(requested) !== bare(first)) {
      return nothing(url, { failed: { url: requested, error: err.errorText || "", noAnswer: err.noAnswer || 0 } });
    }
    throw err;
  }
  await fontsReady(cdp);
  log("Reading the page");
  try {
    await walk(cdp);
  } catch (err) {
    if (!err.timedOut) throw err;
    // Read as it stands, the page would give the browser's default fonts,
    // as the ones it asks for come with the style sheet it waits for.
    return nothing(pageUrl, { stalled: { sheet: [...recorded.due.values()][0] || "" } });
  }
  await fontsReady(cdp);
  await sleep(500);
  // The title and the faces document.fonts holds are read in easyfontkit's
  // own world, where what the page changed in its own does not reach.
  const title = String((await ownEvaluate(cdp, recorded.page.frame, "document.title")) || "").trim();
  const { roles, cut } = await readRoles(cdp, recorded.page.frame);
  // With what the guard cancelled in the page the roles were read from.
  const tried = [...recorded.tried, ...(await triedSoFar(cdp))];
  // A script or a meta refresh can have moved the tab on since the load
  // event navigate() waited for: the page read is the one it shows now. One
  // that has moved on to about:blank shows nothing, and the roles were read
  // from that: left says where it went, and pageUrl is the last web address
  // the tab showed, also after a redirect, and also when it went at its load
  // event, as Chrome then keeps no web address in the tab's history. A blob:
  // address is read, and has no host of its own, so it is named by the page
  // that made it, in the same way.
  const now = await currentAddress(cdp);
  if (/^https?:/i.test(now)) pageUrl = now;
  else if (recorded.page.shown) pageUrl = recorded.page.shown;
  const left = /^about:/i.test(now) ? now : "";
  const loaded = (await ownEvaluate(cdp, recorded.page.frame, "[...document.fonts].filter((f) => f.status === 'loaded').map((f) => ({ family: f.family, weight: f.weight, style: f.style }))")) || [];
  const rules = await readRules(cdp, recorded.sheets, pageUrl, recorded.inline, recorded.page.frame);
  const faces = recorded.faces.map((face) => ({
    family: unquote(face.fontFamily),
    weight: face.fontWeight || "",
    style: face.fontStyle || "",
    src: String(face.src || ""),
    unicodeRange: face.unicodeRange && face.unicodeRange !== "U+0-10FFFF" ? face.unicodeRange : "",
    platformFamily: face.platformFontFamily || "",
  }));
  const { files, skipped, refusedRead, unread } = await readFiles(recorded.fonts, recorded.inline, recorded.refused, recorded.statuses);
  const { failed } = recorded.page;
  // The browser's own error page is titled with the host it could not
  // reach, which is not the site's bot check.
  const challenge = !failed && !files.length && CHALLENGE_TITLE.test(title) ? title : "";
  const answer = { status: recorded.page.status, url: recorded.page.url };
  return { pageUrl, first: recorded.page.first, answer, failed, left, stalled: null, title, challenge, roles, cut, files, skipped, refusedRead, unread, rules, faces, loaded: loaded.map((face) => ({ ...face, family: unquote(face.family) })), asked: [...recorded.asked, ...recorded.inline.keys()], labels: new Map([...recorded.inline].map(([key, font]) => [key, font.label])), tried, triedMore: recorded.triedMore };
}

module.exports = { scanPage, fontFaceRules, cssomRules, readRules, decodeDataUrl, dataKey, dataPrint, record, readFiles };
