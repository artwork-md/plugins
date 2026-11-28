#!/bin/sh
# Runs hook.mjs, Artwork's Codex hooks (hooks.json), on a Node it finds (ART-4255). Codex runs hooks
# with the PATH it was started with, which often lacks the Node a version manager or a GUI app put
# elsewhere, and a bare `node` then failed every Artwork call's hook with exit 127. So it takes the
# first Node 20 or later on the PATH or in the places Node's installers and version managers put it.
# With none, it goes by its argument, the hooks.json entry that ran it (not passed to Node, which reads the event): after an
# Artwork call (`PostToolUse`) it says so once a day per Codex home instead, as hook.mjs's
# `cantWakeOutput` says a thread can't be woken (the words are kept the same as there), says
# nothing in ChatGPT's desktop app, whose chats Artwork's panel wakes, and still refuses
# `artwork_relay` to the model (`refuse`) as decide.mjs's `refusal` does. It never fails the turn.
here=$(dirname "$0")

recent() {
  # Whether $1 runs Node 20 or later.
  [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' 2>/dev/null
}

# Every node on the PATH in its order, then the places installers and version managers use.
on_path=$(printf '%s' "$PATH" | tr ':' '\n' | sed -n 's|^\(..*\)$|\1/node|p')
old_ifs=$IFS
IFS='
'
for node in \
  $on_path \
  "$HOME/.volta/bin/node" \
  "$HOME/.local/share/mise/shims/node" \
  "$HOME/.asdf/shims/node" \
  "$HOME/.local/share/fnm/aliases/default/bin/node" \
  "$HOME"/.nvm/versions/node/v*/bin/node \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /usr/bin/node; do
  if [ -n "$node" ] && recent "$node"; then
    IFS=$old_ifs
    exec "$node" "$here/hook.mjs"
  fi
done
IFS=$old_ifs

# No Node: hooks.json names the entry that ran, so nothing here reads Codex's JSON. Codex's
# event is read and dropped, so its write to the hook never fails.
cat >/dev/null
# hooks.json and this file ship in one plugin folder, so every entry names itself; an entry with
# no name does nothing.
case "$1" in
  refuse)
    printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Artwork'\''s plugin calls artwork_relay itself. Listen with artwork_wait."}}'
    exit 0
    ;;
  PostToolUse) ;;
  *) exit 0 ;;
esac
[ -n "$CODEX_INTERNAL_ORIGINATOR_OVERRIDE" ] && exit 0
data=${PLUGIN_DATA:-${CODEX_HOME:-$HOME/.codex}/plugins/data/artwork-artwork}
mkdir -p "$data/told" 2>/dev/null || exit 0
# Today's mark, made by one hook only, so two at once tell once; the marks of earlier days go.
mkdir "$data/told/no-node-$(date +%Y%m%d)" 2>/dev/null || exit 0
for old in "$data"/told/no-node-*; do
  [ "$old" = "$data/told/no-node-$(date +%Y%m%d)" ] || rmdir "$old" 2>/dev/null
done
why="it needs Node 20 or later, and Codex's hooks found no node on their PATH or where Node is usually installed"
printf '%s' "{\"systemMessage\":\"Artwork can't start this thread when someone comments: $why. The agent sees comments only while it waits in the document.\",\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"Artwork's Codex plugin can't wake this thread on a comment ($why). Listen with artwork_wait as Artwork's answers say, and tell the person once that you see comments only while you wait.\"}}"
exit 0
