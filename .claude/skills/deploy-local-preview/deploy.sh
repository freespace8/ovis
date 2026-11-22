#!/usr/bin/env bash
# Builds the preview worktree and restarts its Ovis server in tmux, then checks that it answers.
set -euo pipefail

WORKTREE="${1:-$HOME/.herdr/worktrees/herdr-web-ui-wt/feat-herdr-session-links}"
SESSION=ovis-link-preview
HOST=192.168.119.106
PORT=17890
PREVIEW="$HOME/.cache/ovis-preview"
URL="http://$HOST:$PORT"

cd "$WORKTREE"
mkdir -p "$HOME/.cache/ovis-tmp/deploy-preview"
TMPDIR="$HOME/.cache/ovis-tmp/deploy-preview" bun run build

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
fi
for _ in $(seq 1 40); do
  pgrep -f "$WORKTREE/server" >/dev/null || break
  sleep 0.5
done
if pgrep -af "$WORKTREE/server"; then
  echo "deploy: the old server processes above are still running" >&2
  exit 1
fi

tmux new-session -d -s "$SESSION" -c "$WORKTREE" \
  "HOST=$HOST PORT=$PORT OVIS_TOKEN=\$(cat $PREVIEW/token) OVIS_UPDATES_OFF=1 OVIS_STATE_DIR=$PREVIEW/state bun run server 2>&1 | tee $PREVIEW/server.log"

for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$URL/" || true)" = 200 ] && break
  sleep 1
done
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/" || true)
if [ "$code" != 200 ]; then
  echo "deploy: $URL/ answered $code" >&2
  tail -30 "$PREVIEW/server.log" >&2
  exit 1
fi

echo "commit: $(git -C "$WORKTREE" log -1 --format='%h %s')"
echo "machines:"
curl -sf -H "Authorization: Bearer $(cat "$PREVIEW/token")" "$URL/api/machines" \
  | jq -r '(.machines // .)[] | "  \(.id)  \(.name)  \(.kind)"'
echo "private links:"
while read -r name link; do
  echo "  $name $(curl -s -o /dev/null -w '%{http_code}' "$link")"
done < "$PREVIEW/links.txt"
echo "log:"
tail -15 "$PREVIEW/server.log"
