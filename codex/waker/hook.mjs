#!/usr/bin/env node
// @ts-check
/**
 * Artwork's Codex hooks (`hooks.json`), one entry for each event Codex hands it on stdin:
 *
 * - `PostToolUse` on an Artwork tool: notes the thread and the document it worked in, for the
 *   watcher to wait in, then makes sure the watcher runs. The first time a thread can't be woken
 *   from here (`cantWake`), it tells the person and the agent why, once.
 * - `SessionStart`: leaves a note naming the thread and no document, then makes sure the watcher
 *   runs, so a resumed thread wakes from its documents.
 * - `PreToolUse` on `artwork_relay`: refuses it to the model, since only the watcher calls it.
 *
 * Codex gives plugin hooks `PLUGIN_DATA`, the plugin's own folder, where the notes go (`notes/`,
 * a file per call, written whole and renamed into place, so the watcher never reads half a note
 * and never takes one a hook is still writing) and where the watcher keeps its socket and state. A hook never fails the turn: whatever goes
 * wrong, it exits 0 having printed nothing but a refusal or that a thread can't be woken.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectCodex, loadedThreads, socketOf } from "./codex-socket.mjs";
import { artworkToolOf, documentOfCall, refusal } from "./decide.mjs";

/** How long a hook waits for the watcher to answer before starting one. */
const ANSWER_MS = 300;

/**
 * How long a hook gives Codex's app server, all steps together, to say whether it has a thread
 * loaded: well inside the hook's 5 s (`hooks.json`), after `ANSWER_MS`.
 */
const REACH_MS = 2000;

/**
 * How long after a listing without the thread a hook lists again, for an app server back from a
 * restart that hasn't loaded the thread yet: only two listings without it count.
 */
const RELIST_MS = 700;

/**
 * How long a thread told it can't be woken goes before a hook asks again: once a listing shows
 * the thread loaded, its mark goes, so no "can't be woken" stands for good.
 */
const RECHECK_MS = 5 * 60_000;

/** How much of a session's transcript a hook reads for its first line. */
const META_BYTES = 64 * 1024;

/** Why a thread not on Codex's shared app server can't be woken. */
const UNSHARED = "Codex runs this thread on its own, not on the app server it shares";

/** The oldest Node the watcher runs on. */
const NODE_MAJOR = 20;

/** The Codex home Codex runs the hook in. */
function homeOf(/** @type {NodeJS.ProcessEnv} */ env) {
  return env.CODEX_HOME || join(env.HOME ?? "", ".codex");
}

/** Whether the watcher runs on Node `node`, as `process.versions.node` gives it. */
function nodeRuns(node = process.versions.node) {
  return Number(node.split(".")[0]) >= NODE_MAJOR;
}

/** Where the plugin keeps its notes and the watcher's socket. */
export function dataDirOf(/** @type {NodeJS.ProcessEnv} */ env) {
  const home = homeOf(env);
  // Codex names a plugin's data folder `<plugin>-<marketplace>`.
  return env.PLUGIN_DATA || join(home, "plugins", "data", "artwork-artwork");
}

/** The folder in `data` where hooks leave their notes for the watcher, a `.json` file each. */
export function notesOf(/** @type {string} */ data) {
  return join(data, "notes");
}

/** The notes waiting in `data` for the watcher, as file names. */
export function notesIn(/** @type {string} */ data) {
  try {
    return readdirSync(notesOf(data)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

/** The watcher's control socket in `data`. */
export function controlOf(/** @type {string} */ data) {
  return join(data, "waker.sock");
}

/**
 * Whether a watcher answers on `control` within `ANSWER_MS`, having been told to read the notes.
 * @param {string} control
 */
function rouse(control) {
  return new Promise((resolve) => {
    const socket = createConnection({ path: control });
    const done = (/** @type {boolean} */ up) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(up);
    };
    const timer = setTimeout(() => done(false), ANSWER_MS);
    socket.on("connect", () => socket.end("rouse\n", () => done(true)));
    socket.on("error", () => done(false));
  });
}

/**
 * Starts the watcher, detached so it outlives the hook: one per Codex home, since a second gives
 * way to the first (`watcher.mjs`).
 * @param {string} data
 */
export function startWatcher(data) {
  const watcher = join(dirname(fileURLToPath(import.meta.url)), "watcher.mjs");
  const child = spawn(process.execPath, [watcher], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PLUGIN_DATA: data },
  });
  child.unref();
}

/**
 * Leaves `worked` in `data`'s notes for the watcher, before it is roused: a watcher closing at its
 * idle exit may take the rouse and not act on it, but it starts a watcher again for a note.
 * @param {string} data
 * @param {{ at: number, thread?: string, server?: string, document?: string }} worked
 */
function leaveNote(data, worked) {
  const notes = notesOf(data);
  mkdirSync(notes, { recursive: true });
  const note = join(notes, `${worked.at}-${randomUUID()}`);
  writeFileSync(`${note}.tmp`, JSON.stringify(worked));
  renameSync(`${note}.tmp`, `${note}.json`);
}

/** Makes sure a watcher runs and has read the notes, on a Node it runs on. */
async function ensureWatcher(/** @type {string} */ data) {
  if (!nodeRuns()) return;
  if (!(await rouse(controlOf(data)))) startWatcher(data);
}

/**
 * What `SessionStart` does in `data` for `thread`: leaves a note naming the thread and no
 * document, then makes sure a watcher runs (`ensure`), so a watcher that took the rouse while
 * exiting starts again for the note.
 * @param {string} data
 * @param {unknown} thread
 * @param {(data: string) => Promise<void>} ensure
 */
export async function sessionStart(data, thread, ensure = ensureWatcher) {
  // Only once a thread has used Artwork here: a Codex home that never did starts nothing.
  if (!existsSync(join(data, "state.json")) && notesIn(data).length === 0) return;
  // No watcher runs on an older Node to read the note.
  if (!nodeRuns()) return;
  try {
    leaveNote(data, typeof thread === "string" ? { at: Date.now(), thread } : { at: Date.now() });
  } catch {
    // A notes folder no hook can write keeps every call from being noted; the rouse still
    // reaches a watcher that isn't exiting.
  }
  await ensure(data);
}

/**
 * How the session whose transcript is at `path` was started, as the first line Codex writes there
 * says (`session_meta`): `exec` for `codex exec`, or null when the file doesn't say.
 * @param {unknown} path
 */
export function sourceOf(path) {
  if (typeof path !== "string" || path === "") return null;
  try {
    const file = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(META_BYTES);
      const read = readSync(file, buffer, 0, META_BYTES, 0);
      const first = buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? "";
      const meta = JSON.parse(first);
      const source = meta?.type === "session_meta" ? meta.payload?.source : undefined;
      return typeof source === "string" ? source : null;
    } finally {
      closeSync(file);
    }
  } catch {
    return null;
  }
}

/**
 * Whether the watcher can wake `thread` from the Codex home `home`: `why` it can't, in words for
 * the person, or null when it can or nothing shows it can't, and whether a listing `shown` the
 * thread loaded on Codex's shared app server, which `codex exec` doesn't use. It needs Node 20.
 * Only two listings 0.7 s apart that answered without the thread, or a session `codex exec`
 * started (`source`) that no listing shows loaded, count as can't, so an app server slow to
 * answer, away while it restarts or back without the thread yet, says nothing either way.
 * @param {string} thread
 * @param {string} home
 * @param {string | null} source How the session was started (`sourceOf`).
 * @param {string} node Node's version, as `process.versions.node` gives it.
 * @returns {Promise<{ why: string | null, shown: boolean }>}
 */
export async function cantWake(thread, home, source, node = process.versions.node) {
  if (!nodeRuns(node)) {
    return {
      why: `it needs Node ${NODE_MAJOR} or later, and this computer has Node ${node}`,
      shown: false,
    };
  }
  // `codex exec` runs its thread itself; only a listing showing it loaded would say otherwise.
  const unknown = { why: source === "exec" ? UNSHARED : null, shown: false };
  const shown = { why: null, shown: true };
  /** @type {import("./codex-socket.mjs").CodexConnection | undefined} */
  let connection;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(unknown), REACH_MS);
  });
  let done = false;
  const ask = (async () => {
    connection = await connectCodex(socketOf(home), "artwork-waker-check", REACH_MS);
    // Connected after the deadline: closed here, so the hook's process doesn't wait on it.
    if (done) connection.close();
    if ((await loadedThreads(connection, REACH_MS)).has(thread)) return shown;
    await new Promise((resolve) => setTimeout(resolve, RELIST_MS));
    return (await loadedThreads(connection, REACH_MS)).has(thread)
      ? shown
      : { why: UNSHARED, shown: false };
  })().catch(() => unknown);
  try {
    return /** @type {{ why: string | null, shown: boolean }} */ (await Promise.race([ask, late]));
  } finally {
    done = true;
    clearTimeout(timer);
    /** @type {{ close(): void } | undefined} */ (connection)?.close();
  }
}

/**
 * What the hook says when `thread` can't be woken because `why`: to the person, and to the agent,
 * which must listen the way it would with no plugin.
 * @param {string} why
 */
export function cantWakeOutput(why) {
  return {
    systemMessage: `Artwork can't start this thread when someone comments: ${why}. The agent sees comments only while it waits in the document.`,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `Artwork's Codex plugin can't wake this thread on a comment (${why}). Listen with artwork_wait as Artwork's answers say, and tell the person once that you see comments only while you wait.`,
    },
  };
}

/** When `told` was last checked, or null when the thread isn't marked told. */
function checkedAt(/** @type {string} */ told) {
  try {
    return statSync(told).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The file that marks `thread` told it can't be woken, so it is told once, and when it was last
 * checked (its modified time), so it is asked again every `RECHECK_MS`.
 * @param {string} data
 * @param {string} thread
 */
function toldFile(data, thread) {
  return join(data, "told", thread.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/**
 * Claims the telling of `told`: true for the one hook that creates the file, so two hooks running
 * at once tell the thread once.
 * @param {string} told
 */
export function claimTelling(told) {
  try {
    mkdirSync(dirname(told), { recursive: true });
    writeFileSync(told, "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** Reads the hook's input, as Codex writes it to stdin. */
async function input() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function main() {
  const event = await input();
  const data = dataDirOf(process.env);
  switch (event.hook_event_name) {
    case "PreToolUse": {
      const reason = refusal(event.tool_name);
      if (reason !== null) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            },
          }),
        );
      }
      return;
    }
    case "PostToolUse": {
      const named = artworkToolOf(event.tool_name);
      const thread = event.session_id;
      if (named === null || typeof thread !== "string") return;
      const document = documentOfCall(named.tool, event.tool_input, event.tool_response);
      if (document === null) return;
      leaveNote(data, { thread, server: named.server, document, at: Date.now() });
      await ensureWatcher(data);
      // ChatGPT's desktop app, which sets this for the app server it runs, wakes its chats with
      // Artwork's panel instead (`wake-panel`), so the plugin has nothing to say there.
      if (process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE) return;
      const told = toldFile(data, thread);
      const checked = checkedAt(told);
      if (checked !== null && Date.now() - checked < RECHECK_MS) return;
      const { why, shown } = await cantWake(
        thread,
        homeOf(process.env),
        sourceOf(event.transcript_path),
      );
      if (checked === null) {
        if (why !== null && claimTelling(told))
          process.stdout.write(JSON.stringify(cantWakeOutput(why)));
        return;
      }
      if (why !== null) {
        // Still can't: checked again later.
        const now = new Date();
        try {
          utimesSync(told, now, now);
        } catch {
          // Removed meanwhile.
        }
      } else if (shown) {
        // A listing shows it loaded: the mark goes, quietly, as the watcher now waits there.
        try {
          unlinkSync(told);
        } catch {
          // Another hook removed it.
        }
      }
      // Nothing showed either way: the mark stays, and the next call asks again.
      return;
    }
    case "SessionStart":
      await sessionStart(data, event.session_id);
      return;
    default:
      return;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch(() => undefined);
  // Exits once what it printed has left, so a probe still connecting past its deadline doesn't
  // keep Codex waiting for the hook.
  process.stdout.write("", () => process.exit(0));
}
