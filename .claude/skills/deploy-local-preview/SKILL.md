---
name: deploy-local-preview
description: Sync the multi-session branch (feat/herdr-session-links) with upstream main, push it to the freespace8 fork, and redeploy the local preview server (tmux session ovis-link-preview, http://192.168.119.106:17890). Use when asked to deploy, redeploy, restart or update the local preview, or to bring the session-links branch up to date.
---

# Deploy the local preview

The preview runs the `feat/herdr-session-links` branch, which serves every local herdr session as
its own machine and gives each one a private link. It is not on upstream yet, so it lives on the
fork and is deployed from its own worktree.

| What | Where |
| --- | --- |
| Main checkout (`main`, tracks upstream) | `~/work/nijl/ovis` |
| Preview worktree (`feat/herdr-session-links`) | `~/.herdr/worktrees/herdr-web-ui-wt/feat-herdr-session-links` |
| Upstream remote `origin` | `https://github.com/devswha/ovis.git` |
| Fork remote `fork` (SSH, logs in as freespace8) | `git@github.com:freespace8/ovis.git` |
| Server | tmux session `ovis-link-preview`, `http://192.168.119.106:17890` |
| Token, state, log, private links | `~/.cache/ovis-preview/{token,state/,server.log,links.txt}` |

The fork remote uses SSH: this PC keeps no GitHub HTTPS credentials and has no `gh`. This PC has
no Tailscale either, so the server binds the LAN address `192.168.119.106` over plain http.

This skill is committed on `feat/herdr-session-links` only. Drop its commit from the branch before
opening the feature's pull request to upstream.

## Steps

1. **Update main.** In the main checkout: `git fetch origin`, then `git merge --ff-only origin/main`.
   Stop and report when the working tree is not clean or main does not fast-forward. Then
   `git push fork main`, so the fork's main stays equal to upstream.
2. **Make sure no one else works in the worktree.** List the processes whose working directory is
   inside the preview worktree (`readlink /proc/*/cwd`). Only the preview server itself (bun
   `server/index.ts`, `server/session-entry.ts`, `server/pty/pty-host.mjs`, `herdr terminal ...`)
   may be there, and `git status` there must be clean. Otherwise stop and report.
3. **Merge main into the branch.** In the worktree: `git merge --no-edit main`. Never rebase: the
   branch is published on the fork, and a rebase would need a force push. Resolve conflicts by
   keeping both sides' intent, then run step 4 before committing the merge.
4. **Run the fast checks.** In the worktree, with a scratch TMPDIR (this PC's `/tmp` runs out of
   inodes):
   `mkdir -p ~/.cache/ovis-tmp/deploy-preview && TMPDIR=~/.cache/ovis-tmp/deploy-preview bun run check fast`.
   Run it in the background and wait for its notification. For every failing test file, run
   `bun test <file>` in the main checkout too: a failure that main shares is not the branch's. These
   fail on this PC on main as well (2026-11-22), from its environment:
   - `scripts/rust-heartbeat.test.ts` (the script exits 3)
   - `server/herdr-core/terminal-env.test.ts` (the login shell does not give the test profile's
     variables)
   Fix a failure the branch causes before going on.
5. **Push the branch.** `git push fork feat/herdr-session-links` (a plain push; the merge keeps it
   a fast-forward).
6. **Redeploy.** In the worktree: `bash .claude/skills/deploy-local-preview/deploy.sh` (pass another
   worktree path as its argument to deploy that instead). It builds `dist/`, stops the tmux session
   and waits for every old server process to exit, starts the server with the same token, state and
   log, and waits for `/` to answer 200. It then prints the deployed commit, the machines from
   `/api/machines` (`local` plus one `session-name-<name>` per herdr session), the status of each
   private link in `links.txt` (303: it sets its cookie and redirects), and the log's tail.
7. **Report** the commit deployed, the check result with the failures main shares, the machines
   listed, and the link statuses. The log always says the Rust PTY host is unavailable (the
   worktree has no `crates/pty-sidecar` build, so the Node host runs), that `ovis recover` is not
   available (`state_dir_unsafe`), and that the token crosses plain http.
