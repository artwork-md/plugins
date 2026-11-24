// @ts-check
/**
 * A JSON-RPC connection to Codex's local app server (the daemon the Codex TUI runs its threads on),
 * through its control socket, `$CODEX_HOME/app-server-control/app-server-control.sock`. The socket
 * speaks WebSocket, one JSON message per text frame (`codex app-server proxy` hands the same bytes
 * to stdio). Written on Node's own `net`, so the plugin installs nothing: Node's own WebSocket
 * client can't reach a Unix socket.
 *
 * Only what the waker needs: requests and their answers, text frames (fragmented or not), ping and
 * close. Notifications the server sends unasked are dropped.
 */
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";

/**
 * The control socket of the Codex home `home`.
 * @param {string} home
 */
export function socketOf(home) {
  return `${home}/app-server-control/app-server-control.sock`;
}

/**
 * One WebSocket frame `opcode` carrying `payload`, masked as a client's must be.
 * @param {number} opcode
 * @param {Buffer} payload
 */
export function frame(opcode, payload) {
  const mask = randomBytes(4);
  const length = payload.length;
  let head = Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), bigLength(length)]);
  if (length < 126) head = Buffer.from([0x80 | opcode, 0x80 | length]);
  else if (length < 65536)
    head = Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff]);
  const body = Buffer.alloc(length);
  for (let i = 0; i < length; i++) body[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
  return Buffer.concat([head, mask, body]);
}

/** @param {number} length */
function bigLength(length) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(length));
  return bytes;
}

/**
 * The frames whole in `buffer`, and what is left of it: each with its opcode, whether it ends its
 * message, and its payload, unmasked if the sender masked it.
 * @param {Buffer} buffer
 * @returns {{ frames: { opcode: number, fin: boolean, payload: Buffer }[], rest: Buffer }}
 */
export function readFrames(buffer) {
  const frames = [];
  let at = 0;
  while (true) {
    if (buffer.length - at < 2) break;
    const first = buffer[at] ?? 0;
    const second = buffer[at + 1] ?? 0;
    let length = second & 0x7f;
    let offset = at + 2;
    if (length === 126) {
      if (buffer.length - offset < 2) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length - offset < 8) break;
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const masked = (second & 0x80) !== 0;
    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (buffer.length - offset < length) break;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (mask) for (let i = 0; i < length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
    frames.push({ opcode: first & 0x0f, fin: (first & 0x80) !== 0, payload });
    at = offset + length;
  }
  return { frames, rest: buffer.subarray(at) };
}

/**
 * @typedef {{
 *   call(method: string, params?: unknown, ms?: number): Promise<unknown>,
 *   close(): void,
 *   closed: Promise<void>,
 * }} CodexConnection
 */

/**
 * Connects to the app server at `path` and initializes as `client`. Rejects when the socket can't
 * be reached or the handshake fails or takes longer than `ms`; once open, `closed` settles when
 * the connection ends, and every call still waiting then fails. A call unanswered after its `ms`
 * (`ms` unless it names its own) drops the connection, since a server that stopped answering
 * on an open socket would otherwise hold the caller for good.
 * @param {string} path
 * @param {string} client
 * @param {number} ms
 * @returns {Promise<CodexConnection>}
 */
export async function connectCodex(path, client, ms) {
  const socket = createConnection({ path });
  const key = randomBytes(16).toString("base64");
  /** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
  const waiting = new Map();
  let next = 0;
  /** @type {Buffer} */
  let buffer = Buffer.alloc(0);
  /** @type {Buffer[]} */
  let message = [];
  let upgraded = false;
  /** @type {(error: Error) => void} */
  let failOpen = () => {};
  /** @type {() => void} */
  let opened = () => {};
  let ended = () => {};
  const closed = new Promise((resolve) => {
    ended = () => resolve(undefined);
  });
  const end = (/** @type {Error} */ why) => {
    for (const { reject } of waiting.values()) reject(why);
    waiting.clear();
    failOpen(why);
    ended();
  };
  socket.on("error", (error) => end(error));
  socket.on("close", () => end(new Error("Codex's app server closed the connection")));
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
    if (!upgraded) {
      const at = buffer.indexOf("\r\n\r\n");
      if (at < 0) return;
      const head = buffer.subarray(0, at).toString("latin1");
      buffer = buffer.subarray(at + 4);
      if (!/^HTTP\/1\.1 101/.test(head)) {
        socket.destroy();
        end(new Error(`Codex's app server refused the connection: ${head.split("\r\n")[0]}`));
        return;
      }
      upgraded = true;
      opened();
    }
    const { frames, rest } = readFrames(buffer);
    buffer = rest;
    for (const { opcode, fin, payload } of frames) {
      if (opcode === 0x9) socket.write(frame(0xa, payload));
      else if (opcode === 0x8) socket.end();
      else if (opcode === 0x1 || opcode === 0x0) {
        message.push(payload);
        if (fin) {
          const text = Buffer.concat(message).toString("utf8");
          message = [];
          answered(text);
        }
      }
    }
  });

  /** @param {string} text */
  function answered(text) {
    /** @type {{ id?: unknown, result?: unknown, error?: { message?: string } }} */
    let reply;
    try {
      reply = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof reply.id !== "number") return;
    const pending = waiting.get(reply.id);
    if (!pending) return;
    waiting.delete(reply.id);
    if (reply.error) pending.reject(new Error(reply.error.message ?? JSON.stringify(reply.error)));
    else pending.resolve(reply.result);
  }

  /** @param {unknown} message */
  const send = (message) => socket.write(frame(0x1, Buffer.from(JSON.stringify(message), "utf8")));

  const opening = setTimeout(() => {
    socket.destroy();
    end(new Error("Codex's app server didn't answer the connection"));
  }, ms);
  await new Promise((resolve, reject) => {
    failOpen = reject;
    opened = () => resolve(undefined);
    socket.on("connect", () =>
      socket.write(
        `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ),
    );
  });
  clearTimeout(opening);
  failOpen = () => {};

  /** @type {CodexConnection["call"]} */
  const call = (method, params, within = ms) =>
    new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(new Error("Codex's app server closed the connection"));
        return;
      }
      next += 1;
      const id = next;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Codex's app server didn't answer ${method}`));
        socket.destroy();
      }, within);
      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ id, method, params });
    });
  try {
    await call("initialize", {
      clientInfo: { name: client, title: null, version: "0" },
      capabilities: null,
    });
  } catch (error) {
    // Refused, as by an app server that changed what it accepts: the socket goes with it.
    socket.destroy();
    throw error;
  }
  send({ method: "initialized" });
  return { call, close: () => socket.destroy(), closed };
}

/**
 * The threads Codex's app server on `connection` has loaded now, each call answering within `ms`.
 * @param {CodexConnection} connection
 * @param {number} ms
 */
export async function loadedThreads(connection, ms) {
  const loaded = new Set();
  /** @type {string | null} */
  let cursor = null;
  do {
    const page = /** @type {{ data?: unknown, nextCursor?: string | null }} */ (
      await connection.call("thread/loaded/list", cursor ? { cursor } : {}, ms)
    );
    for (const id of Array.isArray(page?.data) ? page.data : []) {
      if (typeof id === "string") loaded.add(id);
    }
    cursor = page?.nextCursor ?? null;
  } while (cursor);
  return loaded;
}
