/**
 * Artwork's Claude Code plugin's hooks module: a comment for the session in an Artwork document
 * starts its turn, with Artwork's relay line, whether the session is idle or busy, with no
 * `artwork_wait` of the agent's own.
 *
 * - Each Artwork call the session makes names a document it works in (`documentOfCall`); those
 *   are kept per session in the plugin's store, so a resumed session wakes from them too.
 * - For each document it waits through `artwork_relay` on the session's own Artwork connection
 *   (`$.mcp.call`, under the grant the session signed in with), call after call, and starts a
 *   turn with each line it answers. It stops waiting in a document the session's newest ones
 *   pushed out, and one the relay refuses, until the session's next Artwork call there.
 * - A line goes in with `$.prompt.submit` as the person's own words: a turn of its own at once
 *   when the session is idle, and once the running turn ends when it is busy. Never appended to
 *   a running turn, which a denied permission prompt ends with the line unread; a submitted line
 *   survives the denial and starts its turn after it.
 * - The server keeps each wake unread until the session's tools read its comment, and offers it
 *   again meanwhile, so a line Claude Code refused, or an answer lost on its way, comes again. Each
 *   line names its wakes' keys, and the module puts no line into the chat whose wakes it already
 *   put there.
 * - The model is never let call `artwork_relay` (`tool.check`, `refusal`). Its own `artwork_wait`
 *   goes ahead: where the waker waits, the server answers it that the plugin wakes the session,
 *   and the waker ends a held wait of the model's already running there and waits for it to
 *   return, so only one of them hands a comment over.
 * - A second Artwork server in the session (one the person added beside the plugin's) keeps its
 *   own desk on the server, so its `artwork_wait` and the waker could both hand one comment over.
 *   While the session's tools show one (`tool.list`), the waker stands aside: it tells the person
 *   once which server to remove, makes no relay call, and refuses that server's `artwork_wait`
 *   only while a relay call it made before still runs.
 *
 * `ARTWORK_PLUGIN_LOG`, a file path, writes each step's time there, which is how the hand-over is
 * timed; it names steps and counts, never what anyone wrote. The hooks module has no Node: files,
 * the clock and the environment go through `$`, and `$` is only ever spelled at its call, which
 * is why each hook does its own work.
 */
import {
  alreadyHanded,
  artworkToolOf,
  documentOfCall,
  HOLD_SECONDS,
  heldFor,
  idOf,
  isKept,
  isRelayNotice,
  type Kept,
  keptOf,
  MANIFEST,
  mergedKept,
  namesSession,
  OFF_LEAST_MS,
  OFF_PAUSE_MS,
  otherArtworkServers,
  pauseAfter,
  RELAY_LEFT_MS,
  RELAY_TOOL,
  refusal,
  relayOff,
  relayRefused,
  SESSION_AGAIN_MS,
  SESSION_ARGUMENT,
  secondServerNotice,
  sessionArgumentOf,
  sessionUnknown,
  standingAsideRefusal,
  toolPrefixOf,
  VERSION_AGAIN_MS,
  versionOf,
  versionUnknown,
  type Wake,
  wakesOf,
  withDocument,
  withHanded,
} from "./waker.ts";

/** The part of Claude Code's hooks API (2.1.330) this module uses. */
interface McpAnswer {
  content?: { type?: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}
interface Host {
  mcp: {
    connect(server: string): Promise<{ isConnected?: boolean; server?: string; reason?: string }>;
    call(server: string, tool: string, args?: Record<string, unknown>): Promise<McpAnswer>;
  };
  prompt: { submit(prompt: { text: string; asUser: true }): Promise<unknown> };
  session: { id(): Promise<string> };
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  clock: { sleep(ms: number): Promise<void>; now(): Promise<number> };
  env: { get(name: string): Promise<string | undefined> };
  fs: {
    read(path: string): Promise<string>;
    write(path: string, text: string): Promise<void>;
  };
  plugin: { root: string };
  tool: { list(): Promise<unknown> };
  ui: { log(text: string): void };
}
/** What `tool.list` resolves to: the tools, under `value`, or as they are. */
type Listed = { value?: { name: string }[] } | { name: string }[] | undefined;
type Next<E, R> = (event: E) => Promise<R>;
type Hook<E, R> = ($: Host, e: E, next: Next<E, R>) => Promise<R>;
interface On {
  (event: "session.start", hook: Hook<unknown, unknown>): void;
  (event: "session.end", hook: Hook<{ reason?: string; sessionId?: string }, unknown>): void;
  (
    event: "classic.SessionStart",
    hook: Hook<{ source?: string; session_id?: string }, unknown>,
  ): void;
  (event: "tool.list", hook: Hook<unknown, Listed>): void;
  (
    event: "tool.call",
    hook: Hook<
      { tool: string; [arg: string]: unknown },
      { text?: string; deny?: string; isError?: boolean }
    >,
  ): void;
  (
    event: "tool.check",
    hook: Hook<{ tool: string; input: unknown }, { decision: string; reason?: string }>,
  ): void;
  (event: "turn.start", hook: Hook<{ agentId?: string; turnId?: string }, unknown>): void;
  (
    event: "prompt.submit",
    hook: Hook<{ text: string; origin?: { kind?: string } }, { text?: string; drop?: string }>,
  ): void;
  (event: "turn.complete", hook: Hook<{ agentId?: string; reason?: string }, unknown>): void;
}

/** The store key the documents of each session are kept under. */
const SESSIONS = "sessions";

/**
 * The documents of every session, as kept, and the session the process is in now: the chat
 * Claude Code runs, which the waker follows and every call to the plugin's own server names
 * (`SESSION_ARGUMENT`), so the model's calls and the waker's meet in one conversation. A `/clear`
 * or a `/resume` inside the process moves it to another chat (`switchTo`), by the exact id Claude
 * Code gives; null between the old chat's end and the new one's start, when no call names one.
 */
let kept: Kept = {};
let session: string | null = null;
/**
 * The chats this process has left. Right after a `/resume`, `$.session.id()` still gives the chat
 * it left, until the resumed one's first turn: an id here becomes the chat again only by Claude
 * Code's start of it (`classic.SessionStart`), never by that read.
 */
const ended = new Set<string>();
/** Documents named since the waker started, for it to begin waiting in. */
const named: string[] = [];
/** The documents the waker waits in now, by chat and id (`placeOf`). */
const following = new Set<string>();
/**
 * Each chat's wakes: the keys put into it, the newest last (`withHanded`), and those in lines
 * submitted and not yet settled, since a busy session's submit settles only once the line has run,
 * and the relay offers it again meanwhile. A chat's own, so a wake handed to one is still handed
 * to another its relay offers it to, as the chat a `/resume` returns to.
 */
const marks = new Map<string, { handed: Set<string>; pending: Map<string, number> }>();
/** Wakes the waker when a document is named. */
let rouse: (() => void) | null = null;
/**
 * Ends the pause of a document's waker that heard the relay isn't offered, by chat and id
 * (`placeOf`): the session's next Artwork call there asks again at once, once the least pause has
 * passed.
 */
const resting = new Map<string, () => void>();
/** How many of the session's Artwork calls named each document, by id, so a pause sees one it missed. */
const calls = new Map<string, number>();
/**
 * The plugin's own server as the session's tools name it (`toolPrefixOf`), once known: Claude Code
 * runs a server the person configured the same way in its place, under that server's name, which
 * `$.mcp.connect` answers.
 */
let own = "";
let ownKnown = false;
/**
 * The plugin's own server as Claude Code names its tools when it runs the plugin's (`.mcp.json`'s
 * `artwork` in the plugin `artwork`, which `$.mcp.connect` answers as `plugin:artwork:artwork`):
 * the server a call names its session to until the plugin has learned its own, so a session's
 * first calls, before then or before the person signs in, are named as its later ones are.
 */
const PLUGIN_SERVER = toolPrefixOf("plugin:artwork:artwork");
/** Until when, on the host's clock, calls don't name the session: its server refused it then. */
let sessionlessUntil = 0;
/** The session's tools as last listed, judged once the plugin's own server is known. */
let listedTools: readonly string[] = [];
/** The other Artwork servers the session's tools show, while there are any: the waker stands aside. */
let others: string[] = [];
/** The servers the person was told of, so each set is told once. */
let told = "";
/** Relay calls running now, which a second server's `artwork_wait` waits for. */
let relaying = 0;
/**
 * Each document's relay calls running now, and when its last one ended on the host's clock, by
 * id (`idOf`): the plugin's own wait in a document waits only for that document's relay.
 */
const relayIn = new Map<string, { running: number; ended: number }>();
/** The log's path, when `ARTWORK_PLUGIN_LOG` names one, and its lines so far. */
let logPath: string | undefined;
const logged: string[] = [];
let started = false;

/** The tools' names in what `tool.list` or `$.tool.list` gave. */
function namesIn(listed: unknown): string[] {
  const tools = Array.isArray(listed) ? listed : (listed as { value?: unknown } | null)?.value;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    const name = (tool as { name?: unknown } | null)?.name;
    return typeof name === "string" ? [name] : [];
  });
}

/**
 * Notes which other Artwork servers the session's tools show (`otherArtworkServers`): the person
 * is told once of each new set, and when none is left the waker takes up the session's documents
 * again.
 */
function sawTools($: Host, names: readonly string[]): void {
  listedTools = names;
  if (!ownKnown) return;
  const now = otherArtworkServers(names, own);
  const was = others.length > 0;
  others = now;
  if (now.length > 0 && now.join(",") !== told) {
    told = now.join(",");
    $.ui.log(secondServerNotice(now));
  }
  if (was && now.length === 0 && session !== null) {
    told = "";
    named.push(...(kept[session]?.documents ?? []));
    rouse?.();
  }
}

/** Whether an Artwork call `tool` names its chat (`namesSession`): a call to the plugin's own server, once known, else to the one Claude Code runs for the plugin (`PLUGIN_SERVER`). */
async function namesHere($: Host, tool: string): Promise<boolean> {
  const now = await $.clock.now().catch(() => Date.now());
  return namesSession(tool, ownKnown ? own : PLUGIN_SERVER, now, sessionlessUntil);
}

/**
 * The chat the process is in now. Claude Code's start of a chat moves it (`classic.SessionStart`);
 * `$.session.id()` does too, for a host that doesn't raise that, but never back to a chat this
 * process left, which that read still gives for a moment after a `/resume`.
 */
async function current($: Host): Promise<string | null> {
  const id = await $.session.id().catch(() => null);
  if (started && id !== null && id !== session && !ended.has(id)) switchTo($, id);
  return session;
}

/**
 * Moves the process to chat `id`, which Claude Code started (`/clear`, or `/resume` inside it): the
 * chat it was in is left, and the waker takes up the documents `id` keeps, read again from the
 * store, where a `claude --resume` in another process may have kept them since.
 */
function switchTo($: Host, id: string): void {
  if (id === session) return;
  if (session !== null) ended.add(session);
  ended.delete(id);
  session = id;
  if (logPath) void $.fs.write(logPath, logLine("chat-switched")).catch(() => undefined);
  void (async () => {
    const stored = keptOf(await $.store.get(SESSIONS).catch(() => undefined));
    kept = mergedKept(stored, kept);
    if (session !== id) return;
    if (others.length > 0) return;
    named.push(...(kept[id]?.documents ?? []));
    rouse?.();
  })();
}

/**
 * Adds `document` to `chat`'s documents over what the store holds now, so another process's since
 * stay, and keeps them; a store that refuses keeps nothing for a resume, and this process still wakes.
 */
async function save($: Host, chat: string, document: string): Promise<void> {
  const stored = keptOf(await $.store.get(SESSIONS).catch(() => undefined));
  kept = withDocument(mergedKept(stored, kept), chat, document, Date.now());
  await $.store.set(SESSIONS, kept).catch(() => undefined);
}

/** Where the waker of chat `chat` waits in a document, by its id: its key in `following` and `resting`. */
function placeOf(chat: string, document: string): string {
  return `${chat}\n${idOf(document)}`;
}

/** Chat `chat`'s wakes, handed and pending. */
function marksOf(chat: string): { handed: Set<string>; pending: Map<string, number> } {
  let mine = marks.get(chat);
  if (!mine) {
    mine = { handed: new Set(), pending: new Map() };
    marks.set(chat, mine);
  }
  return mine;
}

/**
 * Hands `wake`'s line to `chat`: a turn of its own, now or once the running turn ends. Its
 * keys not yet handed are pending from the moment it is submitted, since a busy session's
 * submit settles only once the line has run, and the relay offers it again meanwhile; taken,
 * they count as handed; refused, this line lets go of them, and a key no other unsettled line
 * holds comes again at the relay's next offer, while keys already handed stay handed. Once the
 * process has left `chat`, it hands nothing: the wake stays unread for that chat's resume.
 */
async function hand($: Host, chat: string, wake: Wake): Promise<void> {
  const { handed, pending } = marksOf(chat);
  if (alreadyHanded(wake, handed, pending)) {
    if (logPath) await $.fs.write(logPath, logLine("hand-again")).catch(() => undefined);
    return;
  }
  // Each unsettled line holds its keys, so one settling frees none another still carries.
  const mine = wake.keys.filter((key) => !handed.has(key));
  for (const key of mine) pending.set(key, (pending.get(key) ?? 0) + 1);
  if (logPath)
    await $.fs
      .write(logPath, logLine("hand", `${wake.line.length} characters`))
      .catch(() => undefined);
  // Checked with nothing between it and the submit, so a switch during the write hands nothing.
  const taken =
    session === chat
      ? await $.prompt.submit({ text: wake.line, asUser: true }).catch((error) => ({
          deny: String(error),
        }))
      : { drop: "left" };
  for (const key of mine) {
    const left = (pending.get(key) ?? 1) - 1;
    if (left > 0) pending.set(key, left);
    else pending.delete(key);
  }
  const refused = taken as { deny?: string; drop?: string } | undefined;
  if (refused?.deny || refused?.drop) {
    if (logPath) await $.fs.write(logPath, logLine("hand-refused")).catch(() => undefined);
    return;
  }
  withHanded(handed, wake.keys);
  if (logPath) await $.fs.write(logPath, logLine("handed")).catch(() => undefined);
}

/** Has the waker wait in `document` for the chat now, unless it waits there already. */
function follow(document: string): void {
  // Standing aside, the waker takes the session's kept documents up again when it may.
  if (others.length > 0 || session === null) return;
  const id = idOf(document);
  calls.set(id, (calls.get(id) ?? 0) + 1);
  const place = placeOf(session, document);
  if (following.has(place)) {
    resting.get(place)?.();
    return;
  }
  named.push(document);
  rouse?.();
}

/** The log's text with `event` added at the time now; `$.fs` writes whole files only. */
function logLine(event: string, detail = ""): string {
  logged.push(`${Date.now()}\t${event}\t${detail.replace(/[\t\n]/g, " ")}`);
  if (logged.length > 2000) logged.splice(0, logged.length - 2000);
  return `${logged.join("\n")}\n`;
}

/** Follows Claude Code from chat to chat in the process: `/clear` and `/resume` inside it. */
function followChats(on: On): void {
  // A `/clear` or `/resume` inside the process ends the chat it was in, then starts the next.
  // Between the two, no call names a chat and no line is handed to one, unless Claude Code's id
  // already gives a chat the process hasn't left, as right after a `/clear` (`current`).
  on("session.end", async (_$, e, next) => {
    if ((e.reason === "clear" || e.reason === "resume") && e.sessionId) {
      ended.add(e.sessionId);
      if (session === e.sessionId) session = null;
    }
    return next(e);
  });

  // The chat Claude Code starts in the process, by its exact id: the process's first start is
  // `session.start`'s; any later one, a `/clear`'s or a `/resume`'s, moves the process there.
  on("classic.SessionStart", async ($, e, next) => {
    if (started && typeof e.session_id === "string" && e.session_id !== "") {
      switchTo($, e.session_id);
    }
    return next(e);
  });
}

export function register(on: On): void {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    if (started) return result;
    started = true;
    logPath = await $.env.get("ARTWORK_PLUGIN_LOG");
    session = await $.session.id();
    kept = keptOf(await $.store.get(SESSIONS).catch(() => undefined));
    let server: string | null = null;
    // Read once: the manifest changes only with an update, which loads the module again. Any
    // failure, a host without `$.plugin` included, names no version and still wakes.
    const version = versionOf(
      await (async () => $.fs.read(`${$.plugin.root}/${MANIFEST}`))().catch(() => undefined),
    );
    // COMPAT(relay-unversioned-server): added in 2026-11-19, remove after 2027-01-31, by when every
    // local server has run a build whose artwork_relay takes plugin_version. Until then, a server
    // that refuses it is asked without it, and with it again `VERSION_AGAIN_MS` later, in case it
    // was updated meanwhile.
    let unversionedUntil = 0;
    // Named on each relay call, so the server can answer this plugin by its version.
    const relayArgs = (document: string, now: number, chat: string) => ({
      document,
      timeout_seconds: HOLD_SECONDS,
      ...(version === undefined || now < unversionedUntil ? {} : { plugin_version: version }),
      ...(now < sessionlessUntil ? {} : { [SESSION_ARGUMENT]: sessionArgumentOf(chat) }),
    });

    /**
     * Waits in `document` for `chat` while the process is in that chat and it stays one of the
     * chat's documents, handing each line over. Once the process leaves the chat, its call running
     * then runs out, naming it, and hands nothing; the new chat's own waker waits beside it.
     */
    const followIn = async (via: string, document: string, chat: string): Promise<void> => {
      let failures = 0;
      const id = idOf(document);
      const place = placeOf(chat, document);
      while (session === chat && isKept(kept, chat, document) && others.length === 0) {
        // The session's calls here so far, so a pause sees one made while this call ran.
        const called = calls.get(id) ?? 0;
        if (logPath) await $.fs.write(logPath, logLine("relay-call")).catch(() => undefined);
        // Read after the write, so an hour that ran out meanwhile names the version again.
        const now = await $.clock.now().catch(() => Date.now());
        // Checked again with nothing between: a second server, or a switch, during the writes.
        const here = await current($);
        if (others.length > 0 || here !== chat) break;
        // Built here, so a refusal another document's call met during the write counts.
        const args = relayArgs(document, now, chat);
        relaying += 1;
        const relay = relayIn.get(id) ?? { running: 0, ended: 0 };
        relayIn.set(id, relay);
        relay.running += 1;
        const answer = await $.mcp
          .call(via, RELAY_TOOL, args)
          .catch((error: unknown) => ({ isError: true, failed: error }) as const);
        // When it ended, on the clock the hold waits by, before it counts as ended.
        relay.ended = await $.clock.now().catch(() => Date.now());
        relay.running -= 1;
        relaying -= 1;
        // Ended and past its window, a document's entry goes, so the map holds only live ones.
        for (const [id, one] of relayIn) {
          if (one.running === 0 && relay.ended - one.ended > RELAY_LEFT_MS) relayIn.delete(id);
        }
        if (answer.isError) {
          const why = "failed" in answer ? String(answer.failed) : JSON.stringify(answer.content);
          // COMPAT(sessionless-server): added in 2026-11-22, remove after 2027-01-31. A server that
          // doesn't take the session is asked again at once without it.
          if (sessionUnknown(why)) {
            sessionlessUntil = relay.ended + SESSION_AGAIN_MS;
            continue;
          }
          // COMPAT(relay-unversioned-server): added in 2026-11-19, remove after 2027-01-31. A server
          // that doesn't take the version is asked again at once without it, as is a call that
          // went out with it before another document's refusal.
          if (versionUnknown(why)) {
            unversionedUntil = relay.ended + VERSION_AGAIN_MS;
            if (logPath)
              await $.fs.write(logPath, logLine("relay-unversioned")).catch(() => undefined);
            continue;
          }
          const off = relayOff(why);
          const refused = !off && relayRefused(why);
          const step = refused ? "relay-refused" : "relay-failed";
          if (logPath)
            await $.fs.write(logPath, logLine(off ? "relay-off" : step)).catch(() => undefined);
          if (refused) return;
          // The relay not offered now, as by an older server, it asks again after a pause; once the
          // least has passed, at once if the session called here since this call began, or at its
          // next call here.
          if (off) {
            failures = 0;
            await $.clock.sleep(OFF_LEAST_MS);
            if ((calls.get(id) ?? 0) !== called) continue;
            const woken = new Promise<void>((resolve) => resting.set(place, resolve));
            await Promise.race([$.clock.sleep(OFF_PAUSE_MS - OFF_LEAST_MS), woken]);
            resting.delete(place);
            continue;
          }
          failures += 1;
          await $.clock.sleep(pauseAfter(failures));
          continue;
        }
        failures = 0;
        // A call answered once the process has left its chat hands nothing to the chat that
        // replaced it: a comment's wake stays unread for that chat's next resume, while a
        // decision's answer, recorded with this answer, waits only in its desk, an hour.
        if ((await current($)) !== chat) break;
        const wakes = wakesOf(answer);
        if (logPath)
          await $.fs
            .write(logPath, logLine("relay-answer", String(wakes.length)))
            .catch(() => undefined);
        // Handed in the order they came, each without waiting for the one before to run.
        for (const wake of wakes) void hand($, chat, wake);
      }
    };

    // The session's documents kept from before it restarted, then each one its calls name. The
    // connection is asked for again whenever a document is named while there is none.
    named.push(...(kept[session]?.documents ?? []));
    void (async () => {
      // Before the first relay call: the plugin's own server, as its tools are named, and any
      // other Artwork server already listed; `tool.list` tells of one added later. Asked here,
      // not in the hook, so the session starts without waiting for its servers.
      const connected = await $.mcp
        .connect("artwork")
        .catch(() => ({ isConnected: false, server: undefined }));
      // Unconnected, the plugin can't relay, and can't tell which server is its own: it judges
      // once a later connect answers.
      if (connected.isConnected && connected.server) {
        server = connected.server;
        own = toolPrefixOf(connected.server);
        ownKnown = true;
        const listed = namesIn(await $.tool.list().catch(() => []));
        sawTools($, listed.length > 0 ? listed : listedTools);
      }
      while (true) {
        if (server === null && named.length > 0) {
          const connected = await $.mcp
            .connect("artwork")
            .catch(() => ({ isConnected: false, server: undefined }));
          if (logPath)
            await $.fs
              .write(logPath, logLine("connect", String(connected.isConnected)))
              .catch(() => undefined);
          if (connected.isConnected && connected.server) {
            server = connected.server;
            own = toolPrefixOf(connected.server);
            ownKnown = true;
            sawTools($, listedTools);
          }
        }
        if (server !== null && others.length === 0 && session !== null) {
          const via = server;
          const chat = session;
          for (const document of named.splice(0)) {
            const place = placeOf(chat, document);
            if (following.has(place)) continue;
            following.add(place);
            void followIn(via, document, chat).finally(() => following.delete(place));
          }
        }
        await new Promise<void>((resolve) => {
          rouse = resolve;
        });
      }
    })();
    return result;
  });

  // Each time the session's tools change: a second Artwork server makes the waker stand aside.
  on("tool.list", async ($, e, next) => {
    const listed = await next(e);
    sawTools($, namesIn(listed));
    return listed;
  });

  on("tool.call", async ($, e, next) => {
    // Standing aside, the plugin's own server still answers a wait in a document where its relay
    // holds, or left a moment ago (`RELAY_LEFT_MS`), that the plugin wakes the session, which it
    // no longer will: the wait starts once the relay call has ended and that window has passed.
    // Checked again after each pause: a relay call may still run, or one may end meanwhile.
    // A wait that names no document waits for every document's relay.
    const named = documentOfCall(e.tool, e, "");
    while (true) {
      if (e.tool !== `mcp__${own}__artwork_wait` || others.length === 0) break;
      const now = await $.clock.now().catch(() => Date.now());
      const places = named === null ? [...relayIn.values()] : [relayIn.get(idOf(named))];
      const running = places.some((place) => (place?.running ?? 0) > 0);
      const since = now - Math.max(0, ...places.map((place) => place?.ended ?? 0));
      const held = heldFor(e.tool, own, others.length > 0, running, since);
      if (held <= 0) break;
      await $.clock.sleep(held);
    }
    // Each call to the plugin's own server names the chat it runs in (`SESSION_ARGUMENT`), so a
    // new connection of it, after `/mcp` or a resume, keeps its name and threads.
    const chat = artworkToolOf(e.tool) === null ? null : await current($);
    const naming = chat !== null && (await namesHere($, e.tool)) ? chat : null;
    let result = await next(
      naming === null ? e : { ...e, [SESSION_ARGUMENT]: sessionArgumentOf(naming) },
    );
    // COMPAT(sessionless-server): added in 2026-11-22, remove after 2027-01-31. Refused, the call
    // changed nothing: it goes again without the session.
    if (naming !== null && result.isError && sessionUnknown(result.text)) {
      sessionlessUntil = (await $.clock.now().catch(() => Date.now())) + SESSION_AGAIN_MS;
      result = await next(e);
    }
    // Only a call the server answered names a document: one it refused may be on another server.
    if (artworkToolOf(e.tool) === null || result.deny !== undefined || result.isError) {
      return result;
    }
    const document = documentOfCall(e.tool, e, result.text ?? "");
    if (logPath) await $.fs.write(logPath, logLine("artwork-call", e.tool)).catch(() => undefined);
    if (document === null || chat === null) return result;
    // Kept for the chat the call ran in, even one the process left while it ran, so the document
    // wakes that chat's resume and never the chat that replaced it.
    await save($, chat, document);
    if (chat === session) follow(document);
    return result;
  });

  followChats(on);

  // Claude Code's notice of a relay call of the waker's that failed starts no turn: the waker asks
  // again by itself, and the model has nothing to do about it.
  on("prompt.submit", async ($, e, next) => {
    if (!isRelayNotice(e)) return next(e);
    if (logPath) await $.fs.write(logPath, logLine("relay-notice-dropped")).catch(() => undefined);
    return { drop: "Artwork's plugin is listening again after a call that failed." };
  });

  // Only the waker calls `artwork_relay`.
  on("tool.check", async ($, e, next) => {
    const reason = refusal(e.tool) ?? standingAsideRefusal(e.tool, own, relaying > 0);
    if (reason === null) return next(e);
    if (logPath) await $.fs.write(logPath, logLine("refused-to-model")).catch(() => undefined);
    return { decision: "deny", reason };
  });

  // A turn of the main loop runs in the chat `$.session.id()` gives then, for a host that ends a
  // chat but raises no start of the next.
  on("turn.start", async ($, e, next) => {
    if (!e.agentId && started) {
      // A chat this process left only while it is in none: a `/resume`'s first turn may still read
      // the chat it left, which must never take the resumed chat's place.
      const id = await $.session.id().catch(() => null);
      if (id !== null && (session === null || !ended.has(id))) switchTo($, id);
    }
    if (logPath && !e.agentId)
      await $.fs.write(logPath, logLine("turn-start")).catch(() => undefined);
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (logPath && !e.agentId)
      await $.fs.write(logPath, logLine("turn-end", e.reason ?? "")).catch(() => undefined);
    return next(e);
  });
}
