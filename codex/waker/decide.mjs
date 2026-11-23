// @ts-check
/**
 * What the Codex waker decides, apart from Codex and the clock, so it can be tested on its own
 * (`decide.test.ts`); `hook.mjs` and `watcher.mjs` wire it to Codex.
 *
 * The waker learns which documents each Codex thread works in from the thread's own Artwork calls
 * (Codex's `PostToolUse` hook), and for each document waits through `artwork_relay` in every thread
 * that worked there and is still open; the server hands each comment to one of them.
 */

/** The Artwork tool a waker waits through. The model is never let call it. */
export const RELAY_TOOL = "artwork_relay";

/** How long one `artwork_relay` call holds: under the minute Codex gives an MCP call. */
export const HOLD_SECONDS = 50;

/** The most documents the waker follows; the one worked in longest ago goes first past it. */
const MOST_DOCUMENTS = 50;

/** The most threads kept per document, the latest first: each still open is waited in. */
export const MOST_THREADS = 5;

/** How long a document no thread has worked in is followed: a week. */
export const KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** How many wakes' keys the waker remembers queueing; past it the oldest goes. */
export const MOST_HANDED = 1000;

/** What starts every relay line, as the server writes it; nothing else is queued. */
const RELAY_MARK = "<Artwork relay> ";

/** A tool as Codex names it to hooks: `mcp__<server>__<tool>`. */
const MCP_TOOL = /^mcp__(.+)__(artwork_[a-z_]+)$/;

/**
 * The Artwork server and tool a hook's `tool_name` names, or null for any other tool. The server
 * is the person's own name for it in Codex (`artwork` after `codex mcp add artwork …`), which the
 * waker calls the relay through.
 * @param {unknown} tool
 * @returns {{ server: string, tool: string } | null}
 */
export function artworkToolOf(tool) {
  if (typeof tool !== "string") return null;
  const match = MCP_TOOL.exec(tool);
  return match ? { server: match[1] ?? "", tool: match[2] ?? "" } : null;
}

/** A document link: `<server>/d/<id>`, with an optional `#thread`. */
const LINK = /\bhttps?:\/\/[^\s/)\]"]+\/d\/[^\s#?/)\]"]+/;

/**
 * The text of an MCP tool's answer as Codex hands it to a hook: its content's text parts.
 * @param {unknown} response
 */
function textOf(response) {
  const content = /** @type {{ content?: unknown } | null} */ (response)?.content;
  if (!Array.isArray(content)) return typeof response === "string" ? response : "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

/**
 * The document an Artwork call works in: its `document` argument (an id, or a link, kept whole so
 * the relay refuses one on another server), or, for `artwork_create`, which names the new document
 * only in its answer, the new document's link there (`createdOf`). Null for a call on no document, for the relay itself,
 * and for an answer Codex marked as an error, which may be about another server's document.
 * @param {string} tool the Artwork tool (`artwork_read`)
 * @param {unknown} input
 * @param {unknown} response
 * @returns {string | null}
 */
export function documentOfCall(tool, input, response) {
  if (tool === RELAY_TOOL) return null;
  if (/** @type {{ isError?: unknown } | null} */ (response)?.isError === true) return null;
  if (tool === "artwork_create") return createdOf(textOf(response));
  const document = /** @type {{ document?: unknown } | null} */ (input)?.document;
  if (typeof document !== "string" || document.trim() === "") return null;
  return LINK.exec(document)?.[0] ?? document.trim();
}

/**
 * The document `artwork_create`'s answer made: its first line is the new document's id, and its
 * second the link to it, `[title](link)`, whose title may hold any link, so the link is the one the
 * line ends with. That link when it names the id, else the id alone; null for an answer that names
 * no id.
 * @param {string} text
 */
function createdOf(text) {
  const [first = "", second = ""] = text.split("\n", 2);
  const id = first.trim();
  if (id === "" || /[\s/#?]/.test(id)) return null;
  const link = /\]\(([^\s()]+)\)\s*$/.exec(second)?.[1] ?? "";
  return LINK.test(link) && idOf(link) === id ? link : id;
}

/**
 * The id a document's name or link names: what keeps one document's two spellings one.
 * @param {string} document
 */
function idOf(document) {
  return /\/d\/([^\s#?/)\]]+)/.exec(document)?.[1] ?? document;
}

/**
 * The key one document is followed by: the Artwork server the thread called, as the person named
 * it in Codex, and the document's id, so the same id on two servers is two documents.
 * @param {string} server
 * @param {string} document
 */
export function documentKey(server, document) {
  return `${server}/${idOf(document)}`;
}

/**
 * One Artwork call a thread made in a document, as a hook hands it to the watcher.
 * @typedef {{ thread: string, server: string, document: string, at: number }} Worked
 */

/**
 * Where each document was worked in, by `documentKey`: the threads that worked there, the latest first, each
 * with the server it called and the document as it named it.
 * @typedef {{ [id: string]: { thread: string, server: string, document: string, at: number }[] }} Follows
 */

/**
 * `follows` with `worked` added among its document's threads by when each last worked there (a
 * note read late doesn't push out a newer one), keeping `MOST_THREADS` per
 * document and `MOST_DOCUMENTS` documents, and none worked in longer than `KEPT_MS` before `now`.
 * @param {Follows} follows
 * @param {Worked} worked
 * @param {number} now
 * @returns {Follows}
 */
export function withWorked(follows, worked, now) {
  const id = documentKey(worked.server, worked.document);
  const before = (follows[id] ?? []).filter((one) => one.thread !== worked.thread);
  // A thread's later note there wins, whichever was read first.
  const earlier = (follows[id] ?? []).find((one) => one.thread === worked.thread);
  const latest = earlier && earlier.at > worked.at ? earlier : worked;
  const threads = [latest, ...before].sort((a, b) => b.at - a.at).slice(0, MOST_THREADS);
  const next = { ...follows, [id]: threads };
  const kept = Object.entries(next)
    .map(
      ([key, threads]) =>
        /** @type {const} */ ([key, threads.filter((one) => now - one.at <= KEPT_MS)]),
    )
    .filter(([, threads]) => threads.length > 0)
    .sort(([, a], [, b]) => (b[0]?.at ?? 0) - (a[0]?.at ?? 0))
    .slice(0, MOST_DOCUMENTS);
  return Object.fromEntries(kept);
}

/**
 * Where the waker waits now: in each document, every thread that worked there in the last
 * `KEPT_MS` before `now` that Codex has loaded (`loaded`). The server hands each comment to one of them and offers it again to that
 * thread until it reads the comment, so no wait is ever stopped while it may hold a wake. A
 * document whose threads are all closed is waited in nowhere, so its agent shows as stopped
 * listening.
 * @param {Follows} follows
 * @param {ReadonlySet<string>} loaded
 * @param {number} now
 * @returns {{ thread: string, server: string, document: string }[]}
 */
export function plan(follows, loaded, now) {
  return Object.values(follows).flatMap((threads) =>
    threads
      .filter((one) => loaded.has(one.thread) && now - one.at <= KEPT_MS)
      .map((one) => ({ thread: one.thread, server: one.server, document: one.document })),
  );
}

/** The key one wait is known by: its thread and its document's `documentKey`. */
export function waitKey(/** @type {{ thread: string, server: string, document: string }} */ wait) {
  return `${wait.thread} ${documentKey(wait.server, wait.document)}`;
}

/** The thread a `waitKey` names: Codex's thread ids hold no space. */
export function threadOfKey(/** @type {string} */ key) {
  return key.split(" ")[0] ?? "";
}

/**
 * One relay line an `artwork_relay` answer carries, with the keys of the wakes it tells of.
 * @typedef {{ line: string, keys: string[] }} Wake
 */

/**
 * The wakes in `structured`, an answer's structured content, or null when it holds none.
 * @param {unknown} structured
 * @returns {Wake[] | null}
 */
function structuredWakes(structured) {
  const wakes = /** @type {{ wakes?: unknown } | null | undefined} */ (structured)?.wakes;
  if (!Array.isArray(wakes)) return null;
  return wakes.flatMap((one) => {
    const { line, keys } = one ?? {};
    // Only a relay line, on one line, is queued: anything else could pose as the person.
    if (typeof line !== "string" || !line.startsWith(RELAY_MARK) || /[\r\n]/.test(line)) return [];
    const named = Array.isArray(keys) ? keys.filter((key) => typeof key === "string") : [];
    // A line with no keys could never be told from one already queued.
    return named.length > 0 ? [{ line, keys: named }] : [];
  });
}

/**
 * The relay lines an `artwork_relay` answer carries, each with its wakes' keys, from its
 * structured content, or from its text read as JSON. An answer without them hands nothing over:
 * the relay offers each unread wake again every 15 seconds.
 * @param {unknown} answer
 * @returns {Wake[]}
 */
export function wakesOf(answer) {
  const { structuredContent, content } =
    /** @type {{ structuredContent?: unknown, content?: unknown } | null} */ (answer) ?? {};
  const direct = structuredWakes(structuredContent);
  if (direct) return direct;
  if (!Array.isArray(content)) return [];
  for (const part of content) {
    if (typeof part?.text !== "string") continue;
    try {
      const found = structuredWakes(JSON.parse(part.text));
      if (found) return found;
    } catch {
      // Not JSON: the answer's plain text, which carries no keys.
    }
  }
  return [];
}

/**
 * Whether `wake` tells only of wakes already queued: the relay offers a wake again until the
 * thread reads its comment, and a line already queued is not queued twice.
 * @param {Wake} wake
 * @param {ReadonlySet<string>} handed
 */
export function alreadyHanded(wake, handed) {
  return wake.keys.every((key) => handed.has(key));
}

/**
 * `handed` with `keys` added, the newest last, keeping the newest `MOST_HANDED`.
 * @param {string[]} handed
 * @param {readonly string[]} keys
 * @returns {string[]}
 */
export function withHanded(handed, keys) {
  const next = [...handed.filter((key) => !keys.includes(key)), ...keys];
  return next.slice(-MOST_HANDED);
}

/**
 * How long to wait before asking again after `failures` failed calls in a row: a second, then
 * doubling to a minute.
 * @param {number} failures
 */
export function pauseAfter(failures) {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, failures - 1));
}

/**
 * How long to wait before asking again after a call said the relay isn't offered to this thread,
 * as while the person's `codex-wake` flag is off: Codex lists a server's tools again when the
 * server says they changed, which artwork.md does within a minute or two of the flag turning on.
 */
export const OFF_PAUSE_MS = 120_000;

/**
 * Whether a failed call says the relay isn't offered here: the server refused it for the flag,
 * or Codex has no such tool on that server, as while the flag is off. The waker asks again after
 * `OFF_PAUSE_MS`.
 * @param {unknown} error
 */
export function relayOff(error) {
  return /flag is off|unknown tool|tool[^\n]*not found|not found[^\n]*tool|no such tool|disabled/i.test(
    String(error),
  );
}

/**
 * Whether a failed call says the waker can't wait in this document from this thread: the thread
 * isn't signed in to the server or its grant was revoked, the document is on another server, the
 * person can no longer open it, or the thread or its server is gone from Codex. The waker stops
 * waiting there until the thread's next Artwork call there; any other failure is asked again.
 * @param {unknown} error
 */
export function relayRefused(error) {
  return /isn't approved there yet|refused the \w+ grant|on another server|does not have access|No document at this link|thread not found|unknown thread|unknown (mcp )?server|server[^\n]*not found/i.test(
    String(error),
  );
}

/**
 * Why the model's call of `tool` is refused, or null: `artwork_relay`, from any Artwork server,
 * which only the waker calls.
 * @param {unknown} tool
 */
export function refusal(tool) {
  return artworkToolOf(tool)?.tool === RELAY_TOOL
    ? "Artwork's plugin calls artwork_relay itself. Listen with artwork_wait."
    : null;
}
