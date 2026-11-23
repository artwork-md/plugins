/**
 * What the plugin's waker decides, apart from Claude Code's hooks API, so it can be tested on its
 * own (`waker.test.ts`); `register.ts` wires it to the session.
 *
 * The waker learns the documents its session works in from the session's own Artwork calls,
 * keeps them per session so a resumed session goes on waking, and waits in each through
 * `artwork_relay`, whose answer is the relay lines to start turns with.
 */

/** The Artwork tool a waker waits through. The model is never let call it. */
export const RELAY_TOOL = "artwork_relay";

/** How long one `artwork_relay` call holds, its longest: under the minute a host gives a call. */
export const HOLD_SECONDS = 50;

/** The plugin's manifest, under its folder (`$.plugin.root`), whose `version` each relay call names. */
export const MANIFEST = ".claude-plugin/plugin.json";

/**
 * The plugin's version from its manifest's text, which each relay call sends as
 * `plugin_version` so the server can answer this plugin by its version. Undefined for a
 * manifest that names none or can't be read, and the call then names none, as an older plugin
 * does, which the server serves as before.
 */
export function versionOf(manifest: string | undefined): string | undefined {
  if (manifest === undefined) return undefined;
  try {
    const { version } = JSON.parse(manifest) as { version?: unknown };
    return typeof version === "string" && version.trim() !== "" ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

// COMPAT(relay-unversioned-server): added in 2026-11-19, remove after 2027-01-31
/**
 * Whether a relay call failed because its server doesn't take `plugin_version`, as an older server
 * refuses an argument it doesn't name. The waker then calls again at once without it, and names it
 * again `VERSION_AGAIN_MS` later, so a newer plugin still wakes on an older server.
 */
export function versionUnknown(error: unknown): boolean {
  return /doesn't take the argument plugin_version\b/.test(String(error));
}

/**
 * How long after a server refused `plugin_version` the waker names its version again, in case the
 * server was updated meanwhile: on a server that stays old, at most one refused call an hour for
 * each document the waker follows.
 */
export const VERSION_AGAIN_MS = 60 * 60_000;

/** The most documents one session wakes from; the oldest named goes first past it. */
export const MOST_DOCUMENTS = 20;

/** The most sessions whose documents are kept for a resume; the one seen longest ago goes. */
export const MOST_SESSIONS = 30;

/** How many wakes' keys a waker remembers putting into the chat; past it the oldest goes. */
export const MOST_HANDED = 1000;

/** What starts every relay line, as the server writes it; nothing else is handed over. */
const RELAY_MARK = "<Artwork relay> ";

/**
 * An Artwork tool as Claude Code names it, from any server: Artwork's plugin
 * (`mcp__plugin_artwork_artwork__…`) or one the person added (`mcp__artwork__…`).
 */
const ARTWORK_TOOL = /^mcp__.+__(artwork_[a-z_]+)$/;

/** The Artwork tool `tool` names (`artwork_read`), or null for any other tool. */
export function artworkToolOf(tool: string): string | null {
  return ARTWORK_TOOL.exec(tool)?.[1] ?? null;
}

/** A document link: `<server>/d/<id>`, with an optional `#thread`. */
const LINK = /\bhttps?:\/\/[^\s/)\]]+\/d\/[^\s#?/)\]]+/;

/**
 * The document an Artwork call works in: its `document` argument (an id, or a link, kept whole so
 * the relay refuses one on another server), or, for `artwork_create`, which names the new
 * document only in its answer, the first link there. Null for a call on no document.
 */
export function documentOfCall(
  tool: string,
  input: Record<string, unknown>,
  answer: string,
): string | null {
  const named = artworkToolOf(tool);
  if (named === null || named === RELAY_TOOL) return null;
  if (named === "artwork_create") return LINK.exec(answer)?.[0] ?? null;
  const document = input.document;
  if (typeof document !== "string" || document.trim() === "") return null;
  return LINK.exec(document)?.[0] ?? document.trim();
}

/** The id a document's name or link names: what keeps one document's two spellings one wait. */
export function idOf(document: string): string {
  return /\/d\/([^\s#?/)\]]+)/.exec(document)?.[1] ?? document;
}

/** One relay line an `artwork_relay` answer carries, with the keys of the wakes it tells of. */
export interface Wake {
  line: string;
  keys: string[];
}

/** The wakes in `structured`, an answer's structured content, or null when it holds none. */
function structuredWakes(structured: unknown): Wake[] | null {
  const wakes = (structured as { wakes?: unknown } | null | undefined)?.wakes;
  if (!Array.isArray(wakes)) return null;
  return wakes.flatMap((one) => {
    const { line, keys } = (one ?? {}) as { line?: unknown; keys?: unknown };
    if (typeof line !== "string" || !line.startsWith(RELAY_MARK)) return [];
    const named = Array.isArray(keys) ? keys.filter((key) => typeof key === "string") : [];
    // A line with no keys could never be told from one already put into the chat.
    return named.length > 0 ? [{ line, keys: named }] : [];
  });
}

/** `text` read as JSON, or undefined when it isn't. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The relay lines an `artwork_relay` answer carries, each with its wakes' keys, from its
 * structured content: as the answer names it, or as Claude Code hands it to a hooks module, in
 * place of the text, as its JSON (2.1.327). An answer without them hands nothing over: a line
 * with no keys could never be told from one already handed, and the relay offers each unread
 * wake again every 15 seconds.
 */
export function wakesOf(answer: {
  content?: readonly { type?: string; text?: string }[];
  structuredContent?: unknown;
}): Wake[] {
  const texts = (answer.content ?? []).flatMap((part) =>
    part.type === "text" && part.text ? [part.text] : [],
  );
  return (
    structuredWakes(answer.structuredContent) ??
    texts.map((text) => structuredWakes(parsed(text))).find((wakes) => wakes !== null) ??
    []
  );
}

/**
 * Whether `wake` tells only of wakes already put into the chat, or on their way there in a line
 * Claude Code hasn't settled (`pending`): the relay offers a wake again until the session reads
 * its comment, and a line already handed over is not handed twice.
 */
export function alreadyHanded(
  wake: Wake,
  handed: ReadonlySet<string>,
  pending: ReadonlyMap<string, number> = new Map(),
): boolean {
  return wake.keys.every((key) => handed.has(key) || (pending.get(key) ?? 0) > 0);
}

/** `handed` with `keys` added, the newest last, keeping the newest `MOST_HANDED`. */
export function withHanded(handed: Set<string>, keys: readonly string[]): Set<string> {
  for (const key of keys) {
    handed.delete(key);
    handed.add(key);
  }
  for (const key of handed) {
    if (handed.size <= MOST_HANDED) break;
    handed.delete(key);
  }
  return handed;
}

/**
 * How long to wait before asking again after a call said the person's `wake-relay` flag is off
 * (`relayOff`), so turning it on reaches the session with no reconnect: two minutes, or sooner,
 * once `OFF_LEAST_MS` has passed, at the session's next Artwork call in the document.
 */
export const OFF_PAUSE_MS = 120_000;

/**
 * The least a waker waits after hearing the flag is off: as long as artwork.md keeps a grant's
 * flag, so a call asked sooner would only be refused again.
 */
export const OFF_LEAST_MS = 60_000;

/**
 * Whether a failed call says the person's `wake-relay` flag is off, since the server lists
 * `artwork_relay` only while it is on: the server refused it, or answered that the tool is
 * disabled, as it does before Claude Code lists its tools again, or Claude Code has no such tool
 * to call. Turned on, the server tells Claude Code its tools changed
 * and Claude Code lists them again, so the waker's next ask finds it: on artwork.md idle session
 * or not, and on a local server once a session's Artwork call has had it read the flag again.
 */
export function relayOff(error: unknown): boolean {
  return new RegExp(
    `wake-relay flag is off|Tool ${RELAY_TOOL} disabled|no connected MCP tool "${RELAY_TOOL}"`,
    "i",
  ).test(String(error));
}

/** How Claude Code's notice of an MCP task opens, naming the task, and its server and tool. */
const MCP_TASK = /^MCP task [^()\n]*?\(([^()\n]*)\)/;

/** The line a wrapped task notification says what it is of in (`<summary>…</summary>`). */
const SUMMARY = /^<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>/;

/**
 * Whether a prompt Claude Code is about to start a turn with is its notice of one of the waker's
 * own relay calls, as Claude Code tells of a call that failed, as when the server restarted: a
 * background task's notification of an MCP task of `artwork_relay` ("MCP task … (artwork/
 * artwork_relay) failed"), which the model never calls (`refusal`), so any such notice is the
 * waker's, which backs off and asks again by itself. A notice that only mentions the tool, as of a
 * background command that searched for it, goes ahead.
 */
export function isRelayNotice(prompt: { text: string; origin?: { kind?: string } }): boolean {
  if (prompt.origin?.kind !== "task-notification") return false;
  // The notice is of the task its summary opens with; one quoted after, as in a command, is not.
  const text = prompt.text.trimStart();
  const summary = (SUMMARY.exec(text)?.[1] ?? text).trimStart();
  return MCP_TASK.exec(summary)?.[1]?.endsWith(`/${RELAY_TOOL}`) === true;
}

/**
 * How long to wait before asking again after `failures` failed calls in a row: a second, then
 * doubling to a minute, so a deploy or a lost connection costs a few calls, not a loop.
 */
export function pauseAfter(failures: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, failures - 1));
}

/**
 * Whether a failed call says the waker can't wait in this document: the session's Artwork server
 * doesn't offer `artwork_relay` (one it doesn't list, as while the flag is off, is `relayOff`), the
 * session isn't signed in there or its grant was revoked, the document is on another server, or the person can no longer
 * open it. The waker then stops waiting in that document until the session's next Artwork call
 * there; any other failure is asked again.
 */
export function relayRefused(error: unknown): boolean {
  return /no connected MCP tool|tool \S+ not found|disabled|unknown tool|isn't approved there yet|refused the \w+ grant|on another server|does not have access|No document at this link/i.test(
    String(error),
  );
}

/** The documents each session works in, kept across its restarts, as `$.store` holds them. */
export interface Kept {
  [session: string]: { documents: string[]; at: number };
}

/** `kept` read as the store gave it back: anything else is nothing kept. */
export function keptOf(stored: unknown): Kept {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
  const kept: Kept = {};
  for (const [session, value] of Object.entries(stored)) {
    const { documents, at } = (value ?? {}) as { documents?: unknown; at?: unknown };
    if (!Array.isArray(documents) || typeof at !== "number") continue;
    kept[session] = {
      documents: documents.filter((document): document is string => typeof document === "string"),
      at,
    };
  }
  return kept;
}

/**
 * `kept` with `document` added to `session`'s documents at `now`, the newest last, in place of
 * the same document spelled another way (its id, or its link): past
 * `MOST_DOCUMENTS` the oldest goes, and past `MOST_SESSIONS` the session seen longest ago.
 */
export function withDocument(kept: Kept, session: string, document: string, now: number): Kept {
  const before = kept[session]?.documents ?? [];
  const id = idOf(document);
  const others = before.filter((one) => idOf(one) !== id);
  const documents = [...others, document].slice(-MOST_DOCUMENTS);
  const next: Kept = { ...kept, [session]: { documents, at: now } };
  const sessions = Object.entries(next).sort(([, a], [, b]) => b.at - a.at);
  return Object.fromEntries(sessions.slice(0, MOST_SESSIONS));
}

/** Whether `document`, in any spelling, is still one of `session`'s kept documents. */
export function isKept(kept: Kept, session: string | null, document: string): boolean {
  if (session === null) return false;
  const id = idOf(document);
  return kept[session]?.documents.some((one) => idOf(one) === id) ?? false;
}

/**
 * Why the model's `tool` call is refused, or null: `artwork_relay`, from any Artwork server, which
 * only the waker calls. The model's own `artwork_wait` goes ahead: where the waker waits, the
 * server answers it that the plugin wakes the session.
 */
export function refusal(tool: string): string | null {
  return artworkToolOf(tool) === RELAY_TOOL ? "Artwork's plugin calls artwork_relay itself." : null;
}

/**
 * How Claude Code spells an MCP server's name in its tools' names (`mcp__<server>__<tool>`): each
 * character other than a letter, a digit, `_` or `-` as `_`. `plugin:artwork:artwork`, the
 * plugin's own server, is `plugin_artwork_artwork`.
 */
export function toolPrefixOf(server: string): string {
  return server.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** How Claude Code names a server's `artwork_wait`, which only an Artwork server offers. */
const ARTWORK_WAIT = /^mcp__(.+)__artwork_wait$/;

/**
 * The other Artwork servers in the session, by how its tools name them: each server but the
 * plugin's own (`own`, as `toolPrefixOf` spells it) that offers `artwork_wait`, sorted.
 */
export function otherArtworkServers(tools: readonly string[], own: string): string[] {
  const servers = tools.flatMap((tool) => {
    const server = ARTWORK_WAIT.exec(tool)?.[1];
    return server !== undefined && server !== own ? [server] : [];
  });
  return [...new Set(servers)].sort();
}

/**
 * What the person is told, once, when the session has Artwork's tools from another server beside
 * the plugin's: which one to remove, and that the plugin won't wake the session until they do.
 * Claude Code starts the line with the plugin's name ("artwork:"), so it names Artwork no more.
 * Each server's model wait and the plugin's relay keep apart on the server, so with both a
 * comment could be handed over twice; the plugin stands aside instead.
 */
export function secondServerNotice(servers: readonly string[]): string {
  const named = servers
    .map((server) => `"${server}" (its tools start mcp__${server}__)`)
    .join(", ");
  const one = servers.length === 1;
  return `This session also has Artwork's tools from the MCP server ${named}. Artwork's plugin already brings them, so remove ${one ? "that server" : "those servers"} (/mcp lists ${one ? "it" : "them"}; \`claude mcp remove <name>\`). Until then the plugin won't wake this session when someone comments; artwork_wait still works.`;
}

/**
 * Why the model's call of `tool` is refused while the plugin stands aside for another Artwork
 * server, or null: another server's `artwork_wait` while a relay call of the plugin's still runs,
 * since both could hand one comment over. Its next try, once the relay call ends, goes ahead.
 */
export function standingAsideRefusal(tool: string, own: string, relaying: boolean): string | null {
  if (!relaying) return null;
  const server = ARTWORK_WAIT.exec(tool)?.[1];
  if (server === undefined || server === own) return null;
  return "Artwork's plugin is ending a wait of its own in this session. Call artwork_wait again in a minute.";
}

/**
 * How long after a relay call ends the server still answers the model's wait, on the plugin's
 * own server, that the plugin wakes the session (ten seconds), and a moment more.
 */
export const RELAY_LEFT_MS = 10_000 + 250;

/**
 * How long the model's call of `tool` waits before it checks again: the plugin's own server's
 * `artwork_wait` while the plugin stands aside, for as long as a relay call is still `running`
 * there, then for what is left of `RELAY_LEFT_MS` since one ended `since` ms ago, so the wait
 * doesn't hear that the plugin will wake the session; else 0.
 */
export function heldFor(
  tool: string,
  own: string,
  standingAside: boolean,
  running: boolean,
  since: number,
): number {
  if (!standingAside || tool !== `mcp__${own}__artwork_wait`) return 0;
  return running ? RELAY_LEFT_MS : Math.max(0, RELAY_LEFT_MS - since);
}
