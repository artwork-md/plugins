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
  OFF_LEAST_MS,
  OFF_PAUSE_MS,
  otherArtworkServers,
  pauseAfter,
  RELAY_LEFT_MS,
  RELAY_TOOL,
  refusal,
  relayOff,
  relayRefused,
  secondServerNotice,
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

/** The part of Claude Code's hooks API (2.1.327) this module uses. */
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

/** The documents of every session, as kept, and this session's id. */
let kept: Kept = {};
let session: string | null = null;
/** Documents named since the waker started, for it to begin waiting in. */
const named: string[] = [];
/** The documents the waker waits in now, by id. */
const following = new Set<string>();
/** The keys of the wakes put into the chat, the newest last (`withHanded`). */
const handed = new Set<string>();
/**
 * The keys of the wakes in lines submitted and not yet settled: a busy session's submit settles
 * only once the line has run, and the relay offers it again meanwhile.
 */
const pending = new Map<string, number>();
/** Wakes the waker when a document is named. */
let rouse: (() => void) | null = null;
/**
 * Ends the pause of a document's waker that heard the person's flag is off, by id: the session's
 * next Artwork call there asks again at once, once the least pause has passed.
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

/** Has the waker wait in `document`, unless it waits there already. */
function follow(document: string): void {
  // Standing aside, the waker takes the session's kept documents up again when it may.
  if (others.length > 0) return;
  const id = idOf(document);
  calls.set(id, (calls.get(id) ?? 0) + 1);
  if (following.has(id)) {
    resting.get(id)?.();
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

export function register(on: On): void {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    if (started) return result;
    started = true;
    logPath = await $.env.get("ARTWORK_PLUGIN_LOG");
    session = await $.session.id();
    kept = keptOf(await $.store.get(SESSIONS));
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
    const relayArgs = (document: string, now: number) => ({
      document,
      timeout_seconds: HOLD_SECONDS,
      ...(version === undefined || now < unversionedUntil ? {} : { plugin_version: version }),
    });

    /**
     * Hands `wake`'s line to the session: a turn of its own, now or once the running turn ends.
     * Its keys not yet handed are pending from the moment it is submitted, since a busy session's
     * submit settles only once the line has run, and the relay offers it again meanwhile; taken,
     * they count as handed; refused, this line lets go of them, and a key no other unsettled line
     * holds comes again at the relay's next offer, while keys already handed stay handed.
     */
    const hand = async (wake: Wake): Promise<void> => {
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
      const taken = await $.prompt.submit({ text: wake.line, asUser: true }).catch((error) => ({
        deny: String(error),
      }));
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
    };

    /** Waits in `document` while it stays one of the session's, handing each line over. */
    const followIn = async (via: string, document: string): Promise<void> => {
      let failures = 0;
      const id = idOf(document);
      while (isKept(kept, session, document) && others.length === 0) {
        // The session's calls here so far, so a pause sees one made while this call ran.
        const called = calls.get(id) ?? 0;
        if (logPath) await $.fs.write(logPath, logLine("relay-call")).catch(() => undefined);
        // Read after the write, so an hour that ran out meanwhile names the version again.
        const now = await $.clock.now().catch(() => Date.now());
        // A second server may have shown up during the write: checked again with nothing between.
        if (others.length > 0) break;
        // Built here, so a refusal another document's call met during the write counts.
        const args = relayArgs(document, now);
        relaying += 1;
        const place = relayIn.get(idOf(document)) ?? { running: 0, ended: 0 };
        relayIn.set(idOf(document), place);
        place.running += 1;
        const answer = await $.mcp
          .call(via, RELAY_TOOL, args)
          .catch((error: unknown) => ({ isError: true, failed: error }) as const);
        // When it ended, on the clock the hold waits by, before it counts as ended.
        place.ended = await $.clock.now().catch(() => Date.now());
        place.running -= 1;
        relaying -= 1;
        // Ended and past its window, a document's entry goes, so the map holds only live ones.
        for (const [id, one] of relayIn) {
          if (one.running === 0 && place.ended - one.ended > RELAY_LEFT_MS) relayIn.delete(id);
        }
        if (answer.isError) {
          const why = "failed" in answer ? String(answer.failed) : JSON.stringify(answer.content);
          // COMPAT(relay-unversioned-server): added in 2026-11-19, remove after 2027-01-31. A server
          // that doesn't take the version is asked again at once without it, as is a call that
          // went out with it before another document's refusal.
          if (versionUnknown(why)) {
            unversionedUntil = place.ended + VERSION_AGAIN_MS;
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
          // The flag off, or the relay unlisted while it is, it asks again after a pause; once the
          // least has passed, at once if the session called here since this call began, or at its
          // next call here.
          if (off) {
            failures = 0;
            await $.clock.sleep(OFF_LEAST_MS);
            if ((calls.get(id) ?? 0) !== called) continue;
            const woken = new Promise<void>((resolve) => resting.set(id, resolve));
            await Promise.race([$.clock.sleep(OFF_PAUSE_MS - OFF_LEAST_MS), woken]);
            resting.delete(id);
            continue;
          }
          failures += 1;
          await $.clock.sleep(pauseAfter(failures));
          continue;
        }
        failures = 0;
        const wakes = wakesOf(answer);
        if (logPath)
          await $.fs
            .write(logPath, logLine("relay-answer", String(wakes.length)))
            .catch(() => undefined);
        // Handed in the order they came, each without waiting for the one before to run.
        for (const wake of wakes) void hand(wake);
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
      for (;;) {
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
        if (server !== null && others.length === 0) {
          const via = server;
          for (const document of named.splice(0)) {
            const id = idOf(document);
            if (following.has(id)) continue;
            following.add(id);
            void followIn(via, document).finally(() => following.delete(id));
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
    for (;;) {
      if (e.tool !== `mcp__${own}__artwork_wait` || others.length === 0) break;
      const now = await $.clock.now().catch(() => Date.now());
      const places = named === null ? [...relayIn.values()] : [relayIn.get(idOf(named))];
      const running = places.some((place) => (place?.running ?? 0) > 0);
      const since = now - Math.max(0, ...places.map((place) => place?.ended ?? 0));
      const held = heldFor(e.tool, own, others.length > 0, running, since);
      if (held <= 0) break;
      await $.clock.sleep(held);
    }
    const result = await next(e);
    // Only a call the server answered names a document: one it refused may be on another server.
    if (artworkToolOf(e.tool) === null || result.deny !== undefined || result.isError) {
      return result;
    }
    const document = documentOfCall(e.tool, e, result.text ?? "");
    if (logPath) await $.fs.write(logPath, logLine("artwork-call", e.tool)).catch(() => undefined);
    if (document === null || session === null) return result;
    kept = withDocument(kept, session, document, Date.now());
    // A store that refuses keeps nothing for a resume; this session still wakes.
    await $.store.set(SESSIONS, kept).catch(() => undefined);
    follow(document);
    return result;
  });

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

  on("turn.start", async ($, e, next) => {
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
