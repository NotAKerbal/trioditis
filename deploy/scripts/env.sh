# shellcheck shell=sh
# The one parser and the one writer for deploy/.env and key files, sourced by install.sh and
# deploy/trioditis. Set env_names_file (deploy/install/env-names) before calling env_classified.
#
# There's one form: NAME=value lines, each name once, no carriage returns; comments (#) and
# blank lines are allowed and carry nothing. A value is literal: only the characters
# A-Z a-z 0-9 . _ ~ : / @ + = , % -, so there's nothing for Compose to read differently (no
# ${…} to interpolate, no quotes, no spaces to trim, no # to start a comment). Three
# exceptions, each only as wide as a value the installer writes needs:
# - CONVEX_ADMIN_KEY may hold | (the backend's admin keys are <instance>|<hex>);
# - CADDY_GLOBAL_OPTIONS, CADDY_TRUSTED_PROXIES and INSTALL_TRUSTED_PROXIES may be several
#   such words, each separated by one space (Caddy reads them as separate tokens);
# - BRIDGE_PRIVATE_KEY, AGENT_ACCESS_PRIVATE_KEY and BACKUP_KEY must each be exactly a key:
#   canonical unpadded base64url of 32 bytes, 43 characters.
# And a few settings an operator writes by hand are narrower, so a typo stops the installer
# rather than the service that reads it: LOGIN_BROWSER_MAX is a whole number from 1 to 64,
# DEBIAN_SNAPSHOT a snapshot.debian.org timestamp (20261101T000000Z), and UPDATE_BACKUP_DIR an
# absolute path.

# env_raw_clean FILE: whether FILE's raw bytes hold no NUL and no carriage return, checked
# before the shell reads it (command substitution drops a NUL with at most a warning).
env_raw_clean() {
  [ "$(tr -d '\000\r' <"$1" | wc -c)" = "$(wc -c <"$1")" ]
}

# env_check: reads the text on stdin; prints each line not in that form (by line and name,
# never a value), and fails if any is.
env_check() {
  awk '
    function literal(v) { return v ~ /^[A-Za-z0-9._~:\/@+=,%-]*$/ }
    function words(v) { return v ~ /^([A-Za-z0-9._~:\/@+=,%-]+( [A-Za-z0-9._~:\/@+=,%-]+)*)?$/ }
    function key(v) { return length(v) == 43 && v ~ /^[A-Za-z0-9_-]*[AEIMQUYcgkosw048]$/ }
    /\r/ { print "line " NR " has a carriage return"; bad = 1; next }
    /^[[:space:]]*$/ || /^#/ { next }
    !/^[A-Za-z_][A-Za-z0-9_]*=/ { print "line " NR " isn\047t NAME=value"; bad = 1; next }
    {
      name = $0; sub(/=.*/, "", name)
      value = $0; sub(/^[^=]*=/, "", value)
      if (seen[name]++) { print "line " NR " sets " name " again"; bad = 1 }
      if (name == "BRIDGE_PRIVATE_KEY" || name == "AGENT_ACCESS_PRIVATE_KEY" || name == "BACKUP_KEY") ok = key(value)
      else if (name == "RESTORE_PENDING") ok = value ~ /^[0-9]*$/
      else if (name == "LOGIN_BROWSER_MAX") ok = value ~ /^[1-9][0-9]?$/ && value + 0 <= 64
      else if (name == "DEBIAN_SNAPSHOT") ok = value ~ /^(2[0-9][0-9][0-9][01][0-9][0-3][0-9]T[0-2][0-9][0-5][0-9][0-5][0-9]Z)?$/
      else if (name == "UPDATE_BACKUP_DIR") ok = value ~ /^(\/[A-Za-z0-9._~@+=,%-]+)*\/?$/ && value !~ /(^|\/)\.\.?(\/|$)/
      else if (name == "CONVEX_ADMIN_KEY") ok = value ~ /^[A-Za-z0-9._~:\/@+=,%|-]*$/
      else if (name == "CADDY_GLOBAL_OPTIONS" || name == "CADDY_TRUSTED_PROXIES" || name == "INSTALL_TRUSTED_PROXIES") ok = words(value)
      else ok = literal(value)
      if (!ok) { print "line " NR " (" name ") has a value that isn\047t literal"; bad = 1 }
    }
    END { exit bad }'
}

# env_value NAME: the value of NAME in the checked text on stdin, exactly (empty if unset).
env_value() {
  sed -n "s/^$1=//p"
}

# env_names: the names the checked text on stdin sets.
env_names() {
  sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'
}

# env_kept NAMES SETTINGS KEPT: checks that KEPT (a backup's secrets.env) holds exactly the
# settings in SETTINGS (a checked deploy/.env) whose names NAMES (env-names) lists, other
# than the private keys and BACKUP_KEY: each once, with its value, and nothing else. Prints how many, and
# fails if it doesn't. It reads them apart from the shell's copy, so the two agree or the
# backup isn't published.
env_kept() {
  awk '
    function parse() { name = $0; sub(/=.*/, "", name); value = $0; sub(/^[^=]*=/, "", value) }
    FILENAME == ARGV[1] { if ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*$/) listed[$0] = 1; next }
    FILENAME == ARGV[2] {
      if ($0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/) next
      parse()
      if ((name in listed) && name != "BRIDGE_PRIVATE_KEY" && name != "AGENT_ACCESS_PRIVATE_KEY" && name != "BACKUP_KEY") { want[name] = value; wanted++ }
      next
    }
    {
      parse()
      if ($0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/ || !(name in want) || (name in got) || want[name] != value) bad = 1
      got[name] = 1
      count++
    }
    END { if (bad || count != wanted) exit 1; print count }' "$1" "$2" "$3"
}

# env_classified NAME: whether NAME is one a deploy/.env may hold: listed in env-names (what
# a backup keeps), or one of the server's three keys (what it never does).
env_classified() {
  case "$1" in BRIDGE_PRIVATE_KEY | AGENT_ACCESS_PRIVATE_KEY | BACKUP_KEY) return 0 ;; esac
  # shellcheck disable=SC2154 # env_names_file is set by the caller
  grep -qxF "$1" "$env_names_file"
}

# env_write FILE: writes the text on stdin as FILE, the only way anything writes deploy/.env:
# every line in the form above, else nothing is written; through a private temp file beside
# it (0600) and a rename onto the exact name, so it's never half written and a symlink at the
# name is replaced, not followed. (A setting the operator added stays as it is; the names a
# caller sets must be classified, which install.sh's set_var enforces.)
env_write() {
  env_write_text=$(cat)
  if ! env_write_problems=$(printf '%s\n' "$env_write_text" | env_check); then
    echo "Not writing $1: $(echo "$env_write_problems" | tr '\n' ';' | sed 's/;$//; s/;/; /g')." >&2
    return 1
  fi
  env_write_tmp=$(umask 077 && mktemp "$1.XXXXXX") || return 1
  if ! { printf '%s\n' "$env_write_text" >"$env_write_tmp" && chmod 600 "$env_write_tmp" && mv -T "$env_write_tmp" "$1"; }; then
    rm -f "$env_write_tmp"
    return 1
  fi
}
