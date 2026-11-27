#!/usr/bin/env node
// @ts-check
/**
 * Artwork's Codex waker: one process per Codex home, started by the plugin's hooks (`hook.mjs`),
 * that starts a Codex thread's next turn when someone comments for its agent in an Artwork
 * document, with no click.
 *
 * - The hooks note each Artwork call a thread makes (`notes/`). For each document, the
 *   watcher waits in every thread that worked there and is still loaded in Codex's app server
 *   (`plan`); the server hands each comment to one of them.
 * - It waits through `artwork_relay` on that thread's own Artwork connection, by asking Codex's app
 *   server to call it (`mcpServer/tool/call`), so it waits as the thread's agent, under the grant
 *   the person signed in with, and Artwork never sees another sign-in. Each call holds 50 seconds.
 * - Each relay line it answers goes into the thread with `codex queue`, as the person's own
 *   message: Codex starts a turn with it at once when the thread is idle, and after the running
 *   turn when it is busy.
 * - Each line goes into the thread whose hold the relay handed it to, first, and never again
 *   (`state.json`, saved once Codex took the line); a line Codex didn't take goes in when the
 *   server offers its comment again, 15 s on. A comment may go
 *   in once more per line carrying it that was in flight when its watcher stopped, or after a
 *   `codex queue` that didn't finish (it timed out at `QUEUE_MS`, 15 s, though Codex took the
 *   line): an extra turn each, and no comment lost.
 * - When no thread it follows is loaded for ten minutes, it exits; the next hook starts it again.
 *
 * `ARTWORK_WAKER_LOG`, a file path, writes each step's time there, which is how a wake is timed;
 * it names steps and counts, never what anyone wrote.
 */
import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectCodex, loadedThreads, socketOf } from "./codex-socket.mjs";
import {
  alreadyHanded,
  HOLD_SECONDS,
  OFF_PAUSE_MS,
  pauseAfter,
  plan,
  RELAY_TOOL,
  relayOff,
  relayRefused,
  threadOfKey,
  waitKey,
  wakesOf,
  withHanded,
  withWorked,
} from "./decide.mjs";
import { controlOf, dataDirOf, notesIn, notesOf, startWatcher } from "./hook.mjs";

/** How often the watcher looks again at which threads are loaded, unless a hook rouses it sooner. */
const CHECK_MS = 10_000;

/** How long the watcher stays with nothing to wait in, before it exits. */
const IDLE_MS = 10 * 60_000;

/** How long `codex queue` may take. */
const QUEUE_MS = 15_000;

/** How long Codex's app server may take over a call: past it, the connection is dropped and made again. */
const CALL_MS = 15_000;

/** How long a relay call may take: its hold, and as long again for a slow server. */
const RELAY_CALL_MS = 2 * HOLD_SECONDS * 1000;

/** How long starters that found the control socket dead at once take to rename theirs over it. */
const SETTLE_MS = 200;

const env = process.env;
const data = dataDirOf(env);
const home = env.CODEX_HOME || join(env.HOME ?? "", ".codex");
const statePath = join(data, "state.json");
const logPath = env.ARTWORK_WAKER_LOG;

/** The plugin's version, from its manifest, which each relay call names so the server can tell it. */
const pluginVersion = (() => {
  try {
    const manifest = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      ".codex-plugin",
      "plugin.json",
    );
    const version = JSON.parse(readFileSync(manifest, "utf8")).version;
    return typeof version === "string" ? version : undefined;
  } catch {}
})();

/** @param {string} step @param {string} [detail] */
function log(step, detail = "") {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${Date.now()}\t${step}\t${detail.replace(/[\t\n]/g, " ")}\n`);
  } catch {
    // A log that can't be written changes nothing.
  }
}

/** @typedef {import("./decide.mjs").Follows} Follows */

/**
 * What the watcher keeps across restarts: where each document was worked in, and what it queued.
 * Read once this watcher holds the control socket (`load`), so it starts from what the last one
 * saved.
 */
let state = /** @type {{ follows: Follows, handed: string[] }} */ ({ follows: {}, handed: [] });

/**
 * How many lines being queued now carry each key: a key stays covered until every line carrying
 * it has settled, so holds handed one wake queue it once.
 */
const queueing = /** @type {Map<string, number>} */ (new Map());

function load() {
  try {
    const read = JSON.parse(readFileSync(statePath, "utf8"));
    if (read && typeof read === "object") {
      const strings = (/** @type {unknown} */ list) =>
        Array.isArray(list) ? list.filter((one) => typeof one === "string") : [];
      state = {
        follows: typeof read.follows === "object" && read.follows ? read.follows : {},
        handed: strings(read.handed),
      };
    }
  } catch {
    // Nothing kept yet.
  }
}

/** Writes `state`, and says whether it was written: only while this watcher holds the socket. */
function save() {
  if (!ownsControl()) return false;
  try {
    const temporary = `${statePath}.${process.pid}`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, statePath);
    return true;
  } catch {
    log("save-failed");
    return false;
  }
}

/**
 * Folds the hooks' notes into the follows, and deletes each note it read once the follows are
 * saved. A `SessionStart` note names no document: its thread starts or resumes, so the waits the
 * relay refused there are asked again, as one refused as "thread not found" when Codex closed
 * the thread, which the person resumed before the watcher's next look at the loaded threads
 * (ART-4058). Each note is a whole file a hook renamed into place, so one written meanwhile is read
 * at the next round.
 */
function absorb() {
  const names = notesIn(data);
  if (names.length === 0) return;
  for (const name of names) {
    try {
      const worked = JSON.parse(readFileSync(join(notesOf(data), name), "utf8"));
      const { thread, server, document, at } = worked ?? {};
      if (
        [thread, server, document].every((one) => typeof one === "string") &&
        typeof at === "number"
      ) {
        state.follows = withWorked(state.follows, { thread, server, document, at }, Date.now());
        refused.delete(waitKey({ thread, server, document }));
      } else if (typeof thread === "string") {
        for (const [key, wait] of waits) if (threadOfKey(key) === thread) wait.starts += 1;
        for (const key of refused) if (threadOfKey(key) === thread) refused.delete(key);
      }
    } catch {
      // Unreadable: its thread's next Artwork call notes it again.
    }
  }
  // The notes stay until what they say is saved: a watcher that can't write reads them again.
  if (!save()) return;
  for (const name of names) {
    try {
      unlinkSync(join(notesOf(data), name));
    } catch {
      // Gone already.
    }
  }
}

/**
 * The waits the relay refused, by `waitKey`, until the thread's next Artwork call there, its next
 * `SessionStart`, or a listing without it.
 */
const refused = new Set();

/**
 * Whether the watcher was roused since its round last read the notes: a rouse that comes
 * mid-round, while it connects or lists threads, skips the next pause (and the idle exit) instead
 * of being lost, and the note it came with waiting for `CHECK_MS`.
 */
let roused = false;

/**
 * Ends the main loop's pause, while it pauses, as when Codex's app server goes: one that goes
 * mid-round still gets the pause, so a server that keeps dropping is retried at `pauseAfter`.
 */
let endPause = () => {};

/** Has the main loop read the notes again at once, as when a hook has noted a call. */
function rouse() {
  roused = true;
  endPause();
}

/**
 * Sleeps `ms`, or until `wait` is woken, as when the plan drops it or Codex's app server goes.
 * @param {number} ms
 * @param {{ stop: boolean, wake?: () => void }} [wait]
 */
function sleep(ms, wait) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (wait)
      wait.wake = () => {
        clearTimeout(timer);
        resolve(undefined);
      };
  });
}

/** Where `codex` is: on the path Codex gave the hook, else in the Codex home's own packages. */
const codexCandidates = [
  "codex",
  join(home, "packages", "standalone", "current", "bin", "codex"),
  join(home, "packages", "app-server-daemon", "current", "bin", "codex"),
];

/**
 * Queues `line` into `thread` as the person's message, with the first `codex` that runs.
 * @param {string} thread
 * @param {string} line
 * @returns {Promise<boolean>}
 */
async function queue(thread, line) {
  for (const codex of codexCandidates) {
    const outcome = await new Promise((resolve) => {
      execFile(
        codex,
        ["queue", "--thread", thread, "--message", line],
        { timeout: QUEUE_MS, env },
        (error) => resolve(error === null ? "ok" : String(error.code ?? "failed")),
      );
    });
    if (outcome === "ok") return true;
    if (outcome !== "ENOENT") return false;
  }
  return false;
}

/** @type {import("./codex-socket.mjs").CodexConnection | null} */
let codex = null;

/**
 * One wait running: whether the plan stopped it, what ends its pause, and how many of its thread's
 * `SessionStart` notes the watcher read while it ran. A refusal answering a call made before the
 * thread's latest start, as "thread not found" for a call Codex got while the thread was closed,
 * says nothing of the thread now (ART-4058).
 * @typedef {{ stop: boolean, wake?: () => void, starts: number }} Wait
 */

/** The waits running, by `waitKey`. @type {Map<string, Wait>} */
const waits = new Map();

/**
 * Waits in `document` through `thread`'s Artwork server `server`, call after call, queueing each
 * line the relay answers, until the plan drops the wait or the connection to Codex ends.
 * @param {{ thread: string, server: string, document: string }} where
 * @param {import("./codex-socket.mjs").CodexConnection} connection
 * @param {Wait} wait
 */
async function waitIn(where, connection, wait) {
  const { thread, server, document } = where;
  let failures = 0;
  while (!wait.stop && codex === connection) {
    log("relay-call");
    /** @type {unknown} */
    let answer;
    /** @type {string | null} */
    let failed = null;
    const started = wait.starts;
    try {
      answer = await connection.call(
        "mcpServer/tool/call",
        {
          threadId: thread,
          server,
          tool: RELAY_TOOL,
          arguments: { document, timeout_seconds: HOLD_SECONDS, plugin_version: pluginVersion },
          // The thread names the session, as Codex's own calls name it, so the server keeps the
          // relay and the thread's own calls one session.
          _meta: { "x-codex-turn-metadata": { thread_id: thread, session_id: thread } },
        },
        RELAY_CALL_MS,
      );
    } catch (error) {
      failed = String(error);
    }
    if (codex !== connection) return;
    const isError = /** @type {{ isError?: unknown } | null} */ (answer)?.isError === true;
    if (failed !== null || isError) {
      // Stopped while its call was out, the wait ends at once rather than pausing on the thread's
      // key; its end starts a round, which waits there again if the thread is wanted.
      if (wait.stop) return;
      const why = failed ?? JSON.stringify(/** @type {{ content?: unknown }} */ (answer).content);
      if (relayOff(why)) {
        log("relay-off");
        failures = 0;
        await sleep(OFF_PAUSE_MS, wait);
        continue;
      }
      if (relayRefused(why) && wait.starts !== started) {
        log("relay-refused-before-start");
        continue;
      }
      if (relayRefused(why)) {
        log("relay-refused");
        refused.add(waitKey(where));
        return;
      }
      failures += 1;
      log("relay-failed", String(failures));
      await sleep(pauseAfter(failures), wait);
      continue;
    }
    failures = 0;
    const wakes = wakesOf(answer);
    log("relay-answer", String(wakes.length));
    for (const wake of wakes) {
      if (alreadyHanded(wake, new Set([...state.handed, ...queueing.keys()]))) {
        log("hand-again");
        continue;
      }
      if ((await deliver(thread, wake)) === null) return;
    }
  }
}

/**
 * Queues `wake.line` into `thread`, the thread whose hold the relay handed it to (a comment
 * addressed to that conversation stays with it), and saves its keys once Codex took it. Its keys
 * count as being queued until it settles (`queueing`), so a line two holds were handed goes in
 * once; a line that also carries a comment no other line had goes in for that one. A line Codex didn't take is left
 * to the server, which offers its comment again to that thread every 15 s until its agent reads
 * it. Codex keeps a line queued into a thread it has since closed until the thread is resumed.
 * Says whether Codex took it, or null when this watcher no longer holds the control socket, and
 * rouses its main loop to exit.
 * @param {string} thread
 * @param {{ line: string, keys: string[] }} wake
 * @returns {Promise<boolean | null>}
 */
async function deliver(thread, wake) {
  if (!ownsControl()) {
    rouse();
    return null;
  }
  for (const key of wake.keys) queueing.set(key, (queueing.get(key) ?? 0) + 1);
  log("queue");
  const queued = await queue(thread, wake.line);
  for (const key of wake.keys) {
    const left = (queueing.get(key) ?? 1) - 1;
    if (left > 0) queueing.set(key, left);
    else queueing.delete(key);
  }
  if (!queued) {
    log("queue-failed");
    return false;
  }
  log("queued");
  state.handed = withHanded(state.handed, wake.keys);
  save();
  return true;
}

/** The control socket's file as this watcher made it, to tell when another took it over. */
let controlFile = /** @type {{ ino: number, dev: number } | null} */ (null);

/**
 * Whether the control socket is still this watcher's: two watchers that took over one left by a
 * watcher that died at once can both listen, the later one on a new file, and the earlier one,
 * which no hook can reach any more, exits.
 */
function ownsControl() {
  const now = fileOf(controlOf(data));
  return (
    controlFile !== null &&
    now !== null &&
    now.ino === controlFile.ino &&
    now.dev === controlFile.dev
  );
}

/** The file at `path`, as its device and inode, or null when there is none. */
function fileOf(/** @type {string} */ path) {
  try {
    const { ino, dev } = statSync(path);
    return { ino, dev };
  } catch {
    return null;
  }
}

/**
 * Holds the control socket, so only one watcher runs per Codex home: one already listening there
 * answers, and this one exits. Otherwise it listens on a path of its own and renames that over
 * the control socket, which replaces a dead watcher's at once; two starting together both rename,
 * and the one whose file was replaced finds it out (`ownsControl`) and exits before it queues.
 */
async function holdControl() {
  const control = controlOf(data);
  if (await answers(control)) return null;
  const own = `${control}.${process.pid}`;
  try {
    unlinkSync(own);
  } catch {
    // None left.
  }
  const server = createServer((socket) => {
    socket.on("data", () => {
      log("roused");
      rouse();
    });
    socket.on("error", () => undefined);
  });
  const outcome = await new Promise((resolve) => {
    server.once("error", (error) => resolve(/** @type {NodeJS.ErrnoException} */ (error).code));
    server.listen(own, () => resolve("ok"));
  });
  if (outcome !== "ok") throw new Error(`can't listen on ${own}: ${outcome}`);
  // A starter that took over while this one listened answers now: this one gives way.
  if (await answers(control)) {
    server.close();
    return null;
  }
  // Its own file, taken before the rename: read after it, it could be a rival's that replaced it.
  controlFile = fileOf(own);
  renameSync(own, control);
  // A starter that found the socket dead at the same moment renames its own over it within
  // milliseconds: past this pause, the one still holding it runs, and the rest exit.
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  if (!ownsControl()) {
    server.close();
    return null;
  }
  // Its process, for whoever needs to stop it.
  writeFileSync(join(data, "waker.pid"), String(process.pid));
  return server;
}

/** Whether a watcher answers on `path`. */
function answers(/** @type {string} */ path) {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    socket.on("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

async function main() {
  const control = await holdControl();
  if (control === null) return;
  load();
  log("start");
  let failures = 0;
  let idleSince = Date.now();
  let superseded = false;
  while (true) {
    if (!ownsControl()) {
      superseded = true;
      log("superseded");
      break;
    }
    // Two starting together may write it in either order: the one holding the socket says last.
    const pidPath = join(data, "waker.pid");
    if (!existsSync(pidPath) || readFileSync(pidPath, "utf8") !== String(process.pid))
      writeFileSync(pidPath, String(process.pid));
    roused = false;
    absorb();
    if (codex === null) {
      try {
        const connection = await connectCodex(socketOf(home), "artwork-waker", CALL_MS);
        codex = connection;
        failures = 0;
        log("connect", "true");
        void connection.closed.then(() => {
          if (codex === connection) codex = null;
          log("disconnect");
          for (const wait of waits.values()) wait.wake?.();
          endPause();
        });
      } catch {
        failures += 1;
        log("connect", "false");
      }
    }
    /** @type {{ thread: string, server: string, document: string }[]} */
    let wanted = [];
    const connection = codex;
    // A listing that failed changes no wait: the connection is made again if it went.
    const loaded = connection && (await loadedThreads(connection, CALL_MS).catch(() => null));
    if (connection && loaded) {
      // A refusal lasts while its thread stays loaded: one Codex closed and the person resumed
      // (its last wait refused as "thread not found") is waited in again.
      for (const key of refused) if (!loaded.has(threadOfKey(key))) refused.delete(key);
      wanted = plan(state.follows, loaded, Date.now()).filter(
        (where) => !refused.has(waitKey(where)),
      );
      const keys = new Set(wanted.map(waitKey));
      for (const [key, wait] of waits) {
        if (!keys.has(key)) {
          wait.stop = true;
          wait.wake?.();
        }
      }
      for (const where of wanted) {
        const key = waitKey(where);
        if (waits.has(key)) continue;
        const wait = { stop: false, starts: 0 };
        waits.set(key, wait);
        void waitIn(where, connection, wait).finally(() => {
          if (waits.get(key) === wait) waits.delete(key);
          // A wait stopped while its call was out may be wanted again by now, as for a thread
          // resumed meanwhile, which a round skipped while this one still held its key.
          if (wait.stop) rouse();
        });
      }
    }
    if (wanted.length > 0 || waits.size > 0) idleSince = Date.now();
    else if (!roused && Date.now() - idleSince > IDLE_MS) break;
    if (roused) continue;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, codex === null ? pauseAfter(failures) : CHECK_MS);
      endPause = () => {
        clearTimeout(timer);
        resolve(undefined);
      };
    });
    endPause = () => {};
  }
  log("exit");
  codex?.close();
  // The server listened on its own path, which closing deletes; the control socket stays for the
  // next watcher to replace. Once it is closed a hook finds no watcher and starts one; a note a
  // hook left after this watcher's last round, having roused it, starts one here. Every hook that
  // rouses leaves a note first, where it can write one, so none is lost to a rouse this watcher
  // took and didn't act on.
  control.close();
  // A superseded watcher's holds may still be out: it goes at once.
  if (superseded) process.exit(0);
  if (notesIn(data).length > 0) startWatcher(data);
}

await main().catch((error) => {
  log("crash", String(error).slice(0, 200));
  process.exitCode = 1;
});
