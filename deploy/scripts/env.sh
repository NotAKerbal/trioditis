# shellcheck shell=sh
# The one parser for deploy/.env and key files, sourced by install.sh and deploy/trioditis
# (backup, keys import and export). There's one form: NAME=value lines, the value unquoted,
# each name once, no carriage returns; comments (#) and blank lines are allowed and carry
# nothing. Compose reads more (`export NAME=…`, spaces around `=`, quoted values that can run
# over lines), so anything else is refused rather than read two ways.

# env_check: reads the text on stdin; prints each line not in that form, and fails if any is.
env_check() {
  awk '
    /\r/ { print "line " NR " has a carriage return"; bad = 1; next }
    /^[[:space:]]*$/ || /^#/ { next }
    !/^[A-Za-z_][A-Za-z0-9_]*=/ { print "line " NR " isn\047t NAME=value"; bad = 1; next }
    {
      name = $0; sub(/=.*/, "", name)
      value = $0; sub(/^[^=]*=/, "", value)
      if (value ~ /^[[:space:]]*["\047`]/) { print "line " NR " (" name ") has a quoted value"; bad = 1 }
      if (seen[name]++) { print "line " NR " sets " name " again"; bad = 1 }
    }
    END { exit bad }'
}

# env_value NAME: the value of NAME in the checked text on stdin: everything after `NAME=`,
# exactly (empty if it's not set).
env_value() {
  sed -n "s/^$1=//p"
}

# env_names: the names the checked text on stdin sets.
env_names() {
  sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'
}
