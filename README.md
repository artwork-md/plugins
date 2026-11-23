# Artwork plugins for Claude Code and Codex

When someone comments for your agent in an [Artwork](https://artwork.md) document, these plugins start the agent's reply in your Claude Code session or Codex thread. You don't send a message, and the agent doesn't have to sit waiting for comments. This works while the app is running on your computer; a comment left while it's closed waits until you open it.

The agent's next turn opens with one line that says where to look:

```
<Artwork relay> Alex commented in a document | https://artwork.md/d/abc#t1
```

The line names who commented and links to the comment, but never quotes the document. The agent then reads the comment with Artwork's tools and answers it there.

Waking on a comment is in beta and is being turned on account by account. Until it reaches yours, your agent can still work in Artwork with the tools set up below; a comment just won't wake it.

You need an Artwork account. Sign up at [artwork.md](https://artwork.md).

## Claude Code

In your shell:

```
claude plugin install artwork --marketplace artwork-md/plugins
```

Or, inside a session:

```
/plugin marketplace add artwork-md/plugins
/plugin install artwork@artwork
```

The plugin adds Artwork's tools as well as the wake-ups, so don't add Artwork's MCP server separately. The first time the agent uses Artwork, Claude Code asks you to sign in.

A session wakes only for documents it has already used. Ask the agent to read a document ("read https://artwork.md/d/…"), and it wakes for comments there whenever the session is running, including after you resume it.

If you use auto mode, it may block the agent from replying in a comment. Allow the reply tool in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__plugin_artwork_artwork__artwork_comment"]
  }
}
```

**Updates.** Claude Code leaves third-party marketplaces on manual updates. To turn on automatic updates, open `/plugin`, go to **Marketplaces**, select `artwork` and turn on auto-update. To update by hand, run:

```
claude plugin update artwork@artwork
```

## Codex

The Codex plugin brings the wake-ups only, so add Artwork's tools first:

```
codex mcp add artwork --url https://artwork.md/mcp
codex mcp login artwork
```

Then install the plugin:

```
codex plugin marketplace add artwork-md/plugins
codex plugin add artwork@artwork
```

The next time Codex starts, it says "Hooks need review". Review them, check that the hooks you trust come from the Artwork plugin, and trust those: until you do, the plugin's hooks don't run.

It needs Node 20 or later on your path. Threads that Codex's local app server runs can be woken; that's every thread in the terminal UI by default. A `codex exec` run has its own server, so it can't be woken, and the agent tells you so the first time it uses Artwork there.

As in Claude Code, a thread wakes only for documents it has already used.

**Updates.** Run:

```
codex plugin marketplace upgrade artwork
```

Codex asks you to trust the hooks again after each update. Until you do, they don't run, though threads the plugin was already waiting in keep waking.

## What's in this repository

- `claude-code/`: the Claude Code plugin, Artwork's MCP server and a hooks module that starts the session's turn.
- `codex/`: the Codex plugin, hooks and a small Node process that waits for comments through Codex's app server and queues each into its thread.
- `.claude-plugin/` and `.agents/plugins/`: the marketplace files each app reads.

Each commit here is published from Artwork's own repository, and its message names the commit it came from. Changes made directly here would be overwritten by the next publish.

## License

MIT. See [LICENSE](LICENSE).
