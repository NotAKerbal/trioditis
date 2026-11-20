# The sign-in browser's launcher (apps/bridge-host/cmd/login-browser) with Debian's Chromium.
# It holds no secrets but the internal token; see docs/architecture/signin-browser.md.

FROM golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS build

WORKDIR /src
COPY go.work go.work.sum ./
COPY apps/bridge-host/go.mod apps/bridge-host/go.sum apps/bridge-host/
COPY apps/bridge-host/third_party/mautrix-signal/go.mod apps/bridge-host/third_party/mautrix-signal/
COPY apps/bridge-host/cmd/login-browser apps/bridge-host/cmd/login-browser
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
  cd apps/bridge-host \
  && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/login-browser ./cmd/login-browser

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

# Fonts, so sign-in pages draw their text and emoji rather than boxes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl chromium fonts-liberation fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/login-browser /usr/local/bin/login-browser

# Chromium's own sandbox needs user namespaces, which containers (and hosts that restrict them
# with AppArmor) don't allow. Instead the launcher runs each login's Chromium as a user of its
# own (LOGIN_BROWSER_UIDS), never used again while the container runs, so one login's
# browser can't read another's profile or reach its processes, nor anything one left behind.
# The container keeps it from everything else. The launcher itself stays root,
# with only the capabilities compose.yml gives it to do that.
ENV LOGIN_BROWSER_ADDR=0.0.0.0:9222 LOGIN_BROWSER_NO_SANDBOX=1 LOGIN_BROWSER_UIDS=20001-1020000 \
  CHROMIUM_PATH=/usr/bin/chromium
ENTRYPOINT ["login-browser"]
