#!/usr/bin/env bash
# Installs a local zerosub build (a tarball of `main`) on Tom's VM without restarting Paseo, keeping the
# plugin's preferences. Usage: scripts/install-vm.sh <tarball>
#
# `paseo plugin remove zerosub` deletes ~/.paseo/plugin-settings/zerosub/ (preferences.json with it), and
# editing the plugin path in config.json doesn't work (the daemon writes its in-memory copy back). So:
# back up, remove, put the preferences back, install the new directory, and reload only once the
# preferences on disk match the backup byte for byte. ~/.paseo/zerosub (accounts, homes, bindings) is
# never touched. Rolling back is the same script with an older tarball, or the command it prints on failure.
#
# PASEO_HOME (default ~/.paseo) and BACKUP_ROOT (default ~/paseo-harness/zerosub-pace) exist for the harness.
set -euo pipefail

die() { echo "install-vm: $*" >&2; exit 1; }
[[ $# -eq 1 ]] || die "usage: $0 <tarball>"
TARBALL=$(realpath -e "$1")
PASEO_HOME=${PASEO_HOME:-$HOME/.paseo}
BACKUP_ROOT=${BACKUP_ROOT:-$HOME/paseo-harness/zerosub-pace}
PREFS_DIR=$PASEO_HOME/plugin-settings/zerosub
PREFS=$PREFS_DIR/preferences.json
pp() { paseo --home "$PASEO_HOME" "$@"; }
installed() { pp --json plugin ls zerosub | node -e '
  let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const p = JSON.parse(s).find((x) => x.id === "zerosub");
    console.log(p ? `${p.path}\t${p.status}\t${p.enabled}` : "");
  });'; }

VERSION=$(tar xzOf "$TARBALL" package/package.json | node -e '
  let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => console.log(JSON.parse(s).version));')
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "tarball has no usable version: '$VERSION'"
TARGET=$PASEO_HOME/plugins/zerosub-fork/$VERSION

IFS=$'\t' read -r OLD_PATH OLD_STATUS _ <<<"$(installed)" || true
[[ -n ${OLD_PATH:-} ]] || die "zerosub isn't installed in $PASEO_HOME; this script only replaces a build"
[[ $OLD_PATH != "$TARGET" ]] || die "$VERSION is already the installed build ($TARGET)"
[[ -s $PREFS ]] || die "no preferences at $PREFS to carry over; refusing to install with defaults"
echo "install-vm: $OLD_PATH ($OLD_STATUS) -> $TARGET"

# 1. Back up, and check the backup before anything changes.
BACKUP=$BACKUP_ROOT/live-backup-$(date -u +%Y%m%dT%H%M%S)
mkdir -p "$BACKUP"
cp "$PREFS" "$PASEO_HOME/config.json" "$BACKUP"/
[[ -f $PASEO_HOME/plugins/sources.json ]] && cp "$PASEO_HOME/plugins/sources.json" "$BACKUP"/
cmp -s "$PREFS" "$BACKUP/preferences.json" || die "backup of preferences doesn't match"
echo "install-vm: backup in $BACKUP"

# 2. Unpack. An existing directory for this version must hold exactly this tarball.
STAGE=$(mktemp -d)
SWAPPING=0
on_exit() {
  local code=$?
  rm -rf "$STAGE"
  if [[ $code -ne 0 && $SWAPPING -eq 1 ]]; then
    echo "install-vm: FAILED mid-swap; zerosub may be missing or on defaults. To restore the old build:" >&2
    echo "  mkdir -p '$PREFS_DIR' && cp '$BACKUP/preferences.json' '$PREFS'" >&2
    echo "  paseo --home '$PASEO_HOME' plugin remove zerosub 2>/dev/null || true; paseo --home '$PASEO_HOME' plugin install '$OLD_PATH'" >&2
    echo "  cmp '$BACKUP/preferences.json' '$PREFS' && paseo --home '$PASEO_HOME' plugin reload zerosub" >&2
  fi
}
trap on_exit EXIT
tar xzf "$TARBALL" -C "$STAGE" --strip-components=1
if [[ -e $TARGET ]]; then
  diff -rq "$STAGE" "$TARGET" >/dev/null || die "$TARGET exists with other contents; move it aside first"
else
  mkdir -p "$(dirname "$TARGET")"
  cp -a "$STAGE" "$TARGET"
fi

restore_prefs() {
  mkdir -p "$PREFS_DIR"
  cp "$BACKUP/preferences.json" "$PREFS"
  cmp -s "$BACKUP/preferences.json" "$PREFS"
}

# 3. Swap. From here a failure may leave zerosub removed, so the exit trap says how to get it back.
SWAPPING=1
pp plugin remove zerosub >/dev/null
# Back before the install, so the new build's first start already reads them.
restore_prefs || die "couldn't put the preferences back"
pp plugin install "$TARGET" >/dev/null
# The install may have written its own; the reload only happens on a byte-for-byte match.
if ! cmp -s "$BACKUP/preferences.json" "$PREFS"; then
  echo "install-vm: the install changed the preferences; putting the backup back"
  restore_prefs || die "preferences differ from the backup; not reloading"
fi
pp plugin reload zerosub >/dev/null
SWAPPING=0

# 4. Check.
cmp -s "$BACKUP/preferences.json" "$PREFS" || die "preferences changed during the reload (backup: $BACKUP)"
IFS=$'\t' read -r NEW_PATH NEW_STATUS NEW_ENABLED <<<"$(installed)"
[[ $NEW_PATH == "$TARGET" ]] || die "daemon reports path $NEW_PATH, expected $TARGET"
[[ $NEW_ENABLED == true ]] || die "zerosub is installed but disabled"
echo "install-vm: zerosub $VERSION installed, status $NEW_STATUS, preferences match $BACKUP/preferences.json"
echo "install-vm: roll back with: $0 <previous tarball>   (previous build: $OLD_PATH)"
