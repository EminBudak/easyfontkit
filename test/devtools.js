"use strict";

// A stand-in for a browser's DevTools endpoint, for tests of how a run
// waits on the browser: /json/version and /json/new over HTTP, and the
// browser's and the tab's connections over WebSocket, each answered as the
// test says. Only tests use this; it is not shipped.
//
// routes: "/json/version", "/json/new", "browser" and "tab" (the two
// connections), each "hold" to take the request and never answer, a number
// of milliseconds to answer that much later, or "refuse" to drop it. A
// function of how many times it was asked before gives one of these.
// calls: a method's result, "hold" to never answer it, a number of
// milliseconds to answer it with {} that much later, a promise of the result
// to answer it once that settles, as a browser held still for a while does,
// or "close" to drop the connection it came on, as a browser that quits
// does. A function of how many times the method was called before, and of
// the call's params, gives one of these. A method not named gets {}.
// Browser.close is answered and calls onClose.

const crypto = require("node:crypto");
const http = require("node:http");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(text) {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff]);
  return Buffer.concat([head, data]);
}

// The messages in what a client sent: each frame's text, masked as a
// client's always is, and what is left of a frame not whole yet.
function messages(buffer) {
  const out = [];
  let at = 0;
  while (buffer.length - at >= 2) {
    const opcode = buffer[at] & 0x0f;
    let length = buffer[at + 1] & 0x7f;
    let start = at + 2;
    if (length === 126) {
      if (buffer.length - at < 4) break;
      length = buffer.readUInt16BE(at + 2);
      start = at + 4;
    }
    if (buffer.length < start + 4 + length) break;
    const mask = buffer.subarray(start, start + 4);
    const data = Buffer.from(buffer.subarray(start + 4, start + 4 + length));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    out.push({ opcode, text: data.toString() });
    at = start + 4 + length;
  }
  return { out, rest: buffer.subarray(at) };
}

function devtools({ routes = {}, calls = {}, onClose = () => {} } = {}) {
  const asked = {};
  const called = {};
  const received = [];
  const sockets = new Set();
  const behaviour = (route) => {
    const given = routes[route];
    const times = asked[route] || 0;
    asked[route] = times + 1;
    return typeof given === "function" ? given(times) : given;
  };
  const server = http.createServer((req, res) => {
    const route = req.url.split("?")[0];
    const port = server.address().port;
    const body = {
      "/json/version": { Browser: "Stand-in/1", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` },
      "/json/new": { id: "1", type: "page", url: "about:blank", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` },
    }[route];
    if (!body) return void res.writeHead(404).end();
    const how = behaviour(route);
    if (how === "hold") return;
    if (how === "refuse") return void req.socket.destroy();
    setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body)), typeof how === "number" ? how : 0);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    const which = req.url.startsWith("/devtools/browser/") ? "browser" : "tab";
    const how = behaviour(which);
    if (how === "hold") return;
    if (how === "refuse") return void socket.destroy();
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64");
    setTimeout(() => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        const { out, rest } = messages(Buffer.concat([buffer, chunk]));
        buffer = rest;
        for (const { opcode, text } of out) {
          if (opcode === 8) return void socket.end(Buffer.from([0x88, 0]));
          if (opcode !== 1) continue;
          const { id, method, params = {} } = JSON.parse(text);
          received.push({ socket: which, method });
          const times = called[method] || 0;
          called[method] = times + 1;
          const answer = !(method in calls) ? {} : typeof calls[method] === "function" ? calls[method](times, params) : calls[method];
          if (answer === "hold") continue;
          if (answer === "close") return void socket.destroy();
          if (typeof answer === "number") {
            setTimeout(() => socket.writable && socket.write(frame(JSON.stringify({ id, result: {} }))), answer).unref();
            continue;
          }
          if (answer && typeof answer.then === "function") {
            answer.then((result) => socket.writable && socket.write(frame(JSON.stringify({ id, result }))));
            continue;
          }
          socket.write(frame(JSON.stringify({ id, result: answer })));
          if (method === "Browser.close") onClose();
        }
      });
    }, typeof how === "number" ? how : 0);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        received,
        close() {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      }),
    ),
  );
}

module.exports = { devtools };
