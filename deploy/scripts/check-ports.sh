#!/bin/sh
# Reads `docker compose config` on stdin and fails, naming each, if a port is published that
# shouldn't be: only Caddy's are. The Convex ports (3210, 3211) never are, by any service:
# the backend trusts the client address Caddy gives it, so nothing may reach it but Caddy.
# Run by install.sh, and by deploy/test/ports.sh for every combination of compose files.
awk '
  /^services:/ { in_services = 1; next }
  /^[^ ]/ { in_services = 0 }
  !in_services { next }
  /^  [^ ]/ { service = $1; sub(/:$/, "", service); in_ports = 0; next }
  /^    ports:/ { in_ports = 1; next }
  /^    [^ -]/ { in_ports = 0 }
  in_ports && /^      - / { entries++; owner[entries] = service }
  in_ports && /host_ip:/ { host_ip[entries] = $NF }
  in_ports && /target:/ { target[entries] = $NF }
  END {
    bad = 0
    for (i = 1; i <= entries; i++) {
      s = owner[i]; t = target[i]; h = host_ip[i]
      if (t == "3210" || t == "3211") { print s " publishes the Convex port " t; bad = 1 }
      else if (s == "caddy") continue
      else { print s " publishes port " t (h == "" ? "" : " on " h); bad = 1 }
    }
    exit bad
  }'
