# zerosub (Tom's fork)

This is `tomgrin10/zerosub`, a fork of `kapybara-org/zerosub` tuned for Tom's setup: two Claude accounts, about 140
agents, one VM. Upstream mergeability is optional; Tom's setup wins where they differ.

## Releases

**A release needs Tom's manual permission, every time.** No agent releases on its own. Features and fixes ship as a
beta by default, except hotfixes (a hotfix skips the beta, not the permission). In this fork:

- A **beta** is a local `X.Y.Z-pace.N` build installed on Tom's VM from a tarball of `main`. Agents may build one;
  the orchestrator reviews the PR and installs it.
- A **release** is anything else: any `npm publish` (any tag), any non-prerelease version in `package.json`, or a
  GitHub release. It needs Tom's explicit OK for that exact version first. Ask him, and quote his OK in the release
  commit body.
- Nothing is ever published or opened against `kapybara-org/zerosub` without Tom.
- **Release notes (Tom's rule, 2026-11-11):** every GitHub release, beta or not, shows clean notes in the same format
  as Tom's other plugins (reference: `tomgrin10/paseo-smart-session`, AGENTS.md "Create a release" and
  `scripts/release-notes.mjs`). Title "ZeroSub vX.Y.Z"; body `## What's new`, then `## Install`, then one line on the
  verification it passed. A beta lists its own changes; an rc or stable gets a curated summary grouped by what a user
  gets (biggest first, plus `### Upgrading from X.Y` when needed), never a dump of commits. No empty or boilerplate
  bodies. In-app What's new popups stay major-only. The fork has no GitHub releases today (`-pace.N` builds are
  local tarballs), so this applies from the first one Tom approves.

## Working rules

- Small PRs into `main`, one change each; each one becomes the next `-pace.N` build.
- `npm run typecheck`, `npm test` and `npm run audit:mobile` pass before a PR.
- Never wake dormant agents: nothing may reload a closed or archived agent, and moves happen one agent at a time
  (no bulk `reconcile` for a background feature).
- Never touch the live daemon, `~/.paseo/zerosub` or live credentials from tests or harnesses; use an isolated
  harness daemon with synthetic accounts.

## Installing a build on the VM (for the orchestrator)

Use the script; don't run the steps by hand:

```sh
~/paseo-harness/tools/reload-gate run zerosub -- scripts/install-vm.sh ~/paseo-harness/zerosub-pace/kapybara-zerosub-<version>.tgz
```

Always run it through `reload-gate` (Tom's rule, 2026-11-11: at most one live plugin reload window every 30 min,
machine-wide). Every live reload marks every live agent stale, so its next message pays a close+resume; the gate
batches reloads into one window and sleeps until the next one. Read the header of `~/paseo-harness/tools/reload-gate`;
bypass only with `RELOAD_GATE_BYPASS="<Tom's words>, <when>"`. Harness daemons (temp `PASEO_HOME`) are exempt.

It never restarts Paseo and never touches `~/.paseo/zerosub` (accounts, homes, bindings). Two facts drive it:

- Editing `plugins.zerosub.path` in `~/.paseo/config.json` and reloading doesn't work: the daemon keeps its config in
  memory and writes the old path back. The build has to be swapped with `paseo plugin remove` + `paseo plugin install`.
- `paseo plugin remove zerosub` deletes the whole `~/.paseo/plugin-settings/zerosub/` directory, preferences included.
  Restoring them by hand once ran zerosub on default preferences for about 20 s, because `cp` into the missing
  directory failed.

So the script runs under `set -euo pipefail` and does the following:

1. It refuses up front when zerosub isn't installed, when the version is already installed, or when there are no
   preferences to carry over.
2. It backs up `preferences.json`, `config.json` and `sources.json` to
   `~/paseo-harness/zerosub-pace/live-backup-<UTC time>/`, then `cmp`s the preferences against the backup.
3. It unpacks the tarball to `~/.paseo/plugins/zerosub-fork/<version>`. An existing directory there must hold exactly
   this tarball.
4. It removes the old build and restores the preferences (`mkdir -p` + `cp` + `cmp`) **before** installing, so the
   new build starts on them.
5. It installs, `cmp`s again, and reloads only on a byte-for-byte match. After the reload it `cmp`s once more and
   checks that the daemon reports the new path, enabled.
6. If anything fails after the remove, it prints the exact commands that put the old build and its preferences back.

To roll back, run the script with the previous tarball. To go back to the registry build, use
`paseo plugin install kapybara-org/zerosub` and restore `preferences.json` from the backup the same way.
