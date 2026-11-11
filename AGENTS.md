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

## Working rules

- Small PRs into `main`, one change each; each one becomes the next `-pace.N` build.
- `npm run typecheck`, `npm test` and `npm run audit:mobile` pass before a PR.
- Never wake dormant agents: nothing may reload a closed or archived agent, and moves happen one agent at a time
  (no bulk `reconcile` for a background feature).
- Never touch the live daemon, `~/.paseo/zerosub` or live credentials from tests or harnesses; use an isolated
  harness daemon with synthetic accounts.

## Installing a build on the VM (for the orchestrator)

Editing `plugins.zerosub.path` in `~/.paseo/config.json` and reloading does not work: the daemon keeps its config in
memory and writes the old path back. What works without a daemon restart:

```sh
F=~/.paseo/plugins/zerosub-fork/<version>
B=~/paseo-harness/zerosub-pace/live-backup-$(date +%Y%m%dT%H%M%S); mkdir -p "$B"
cp ~/.paseo/plugin-settings/zerosub/preferences.json ~/.paseo/config.json ~/.paseo/plugins/sources.json "$B"/
mkdir -p "$F" && tar xzf <tarball> -C "$F" --strip-components=1
paseo plugin remove zerosub                 # also deletes plugin-settings/zerosub/preferences.json
paseo plugin install "$F"
mkdir -p ~/.paseo/plugin-settings/zerosub && cp "$B"/preferences.json ~/.paseo/plugin-settings/zerosub/
paseo plugin reload zerosub
paseo plugin ls zerosub                     # path=$F, status running
```

`~/.paseo/zerosub` (accounts, homes, bindings) is never touched by this. Roll back the same way with
`paseo plugin install kapybara-org/zerosub`.
