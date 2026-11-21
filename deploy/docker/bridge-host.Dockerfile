# The bridge host (Go). Built with cgo: the bridge framework links SQLite, even though
# installs keep the bridge database on Postgres.
#
# Signal's connector also links libsignal (Rust), which takes a long while to build, so it is
# only built in with `--build-arg WITH_SIGNAL=1` (install.sh passes it when Signal is one of
# the networks). Without it the image is as before, and its Signal bridge host says it was
# built without Signal. See docs/networks/signal.md.
ARG WITH_SIGNAL=0

# libsignal_ffi.a, at the version mautrix-signal's bindings were generated against
# (internal/networks/signal_test.go checks the two agree). Built for the platform the image
# is built on, amd64 or arm64; the toolchain image matches libsignal's rust-toolchain file.
FROM rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS libsignal-1
ARG LIBSIGNAL_VERSION=v0.106.1
ARG LIBSIGNAL_COMMIT=904c8dc8216073b078a5f2f5090e3da8382e6a92
ARG DEBIAN_SNAPSHOT=
RUN if [ -n "$DEBIAN_SNAPSHOT" ]; then \
    printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: http://snapshot.debian.org/archive/debian-security/%s\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' \
      "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" >/etc/apt/sources.list.d/debian.sources \
    && echo 'Acquire::Check-Valid-Until "false";' >/etc/apt/apt.conf.d/99snapshot; \
  fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends clang libclang-dev cmake protobuf-compiler libprotobuf-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /libsignal
# The tag is fetched, then checked against the commit it was pinned at, so a moved tag fails
# the build rather than changing what is linked.
RUN git init -q . \
  && git fetch -q --depth 1 https://github.com/signalapp/libsignal.git "refs/tags/$LIBSIGNAL_VERSION" \
  && git checkout -q FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = "$LIBSIGNAL_COMMIT"
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/usr/local/cargo/git \
  --mount=type=cache,target=/libsignal/target \
  cargo build -p libsignal-ffi --release --locked \
  && mkdir -p /out && cp target/release/libsignal_ffi.a /out/

# The library alone, for a dev build without Rust installed:
#   docker build -f deploy/docker/bridge-host.Dockerfile --target libsignal-export -o .data/libsignal .
FROM scratch AS libsignal-export
COPY --from=libsignal-1 /out/ /

# Without Signal: nothing to link.
FROM scratch AS libsignal-0
WORKDIR /out

FROM libsignal-${WITH_SIGNAL} AS libsignal

FROM golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS build

WORKDIR /src
COPY go.work go.work.sum ./
COPY apps/bridge-host/go.mod apps/bridge-host/go.sum apps/bridge-host/
# The patched mautrix-signal the bridge host's go.mod replaces upstream with; resolving the
# modules needs its go.mod.
COPY apps/bridge-host/third_party/mautrix-signal/go.mod apps/bridge-host/third_party/mautrix-signal/
# And the patched mautrix (bridgev2), likewise.
COPY apps/bridge-host/third_party/mautrix/go.mod apps/bridge-host/third_party/mautrix/
RUN --mount=type=cache,target=/go/pkg/mod cd apps/bridge-host && go mod download
COPY --from=libsignal /out/ /libsignal/
ARG DEBIAN_SNAPSHOT=
# With libsignal, the Signal connector is built in (-tags libsignal) and the library linked
# from /libsignal; libsignalgo also links zlib and the C++ runtime.
RUN if [ -f /libsignal/libsignal_ffi.a ]; then \
    if [ -n "$DEBIAN_SNAPSHOT" ]; then \
      printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: http://snapshot.debian.org/archive/debian-security/%s\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' \
        "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" >/etc/apt/sources.list.d/debian.sources \
      && echo 'Acquire::Check-Valid-Until "false";' >/etc/apt/apt.conf.d/99snapshot; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends g++ zlib1g-dev && rm -rf /var/lib/apt/lists/*; \
  fi
COPY apps/bridge-host apps/bridge-host
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
  cd apps/bridge-host \
  && tags='' && if [ -f /libsignal/libsignal_ffi.a ]; then tags=libsignal; fi \
  && CGO_ENABLED=1 LIBRARY_PATH=/libsignal go build -tags "$tags" -trimpath -ldflags='-s -w' -o /out/bridge-host ./cmd/bridge-host

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

# DEBIAN_SNAPSHOT (a snapshot.debian.org time, such as 20261101T000000Z) pins the Debian
# packages below to that day, to build the same image again; unset, they are the newest, with
# their security fixes. install.sh passes the one deploy/.env sets.
ARG DEBIAN_SNAPSHOT=
# A build with Signal loads the C++ runtime (libstdc++6, with libgcc-s1); the base image has
# both, and libstdc++6 is named so that stays true.
RUN if [ -n "$DEBIAN_SNAPSHOT" ]; then \
    printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: http://snapshot.debian.org/archive/debian-security/%s\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' \
      "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" >/etc/apt/sources.list.d/debian.sources \
    && echo 'Acquire::Check-Valid-Until "false";' >/etc/apt/apt.conf.d/99snapshot; \
  fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libstdc++6 \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --create-home bridge \
  && mkdir -p /data && chown bridge:bridge /data
COPY --from=build /out/bridge-host /usr/local/bin/bridge-host

USER bridge
ENV BRIDGE_DATA_DIR=/data BRIDGE_HOST_ADDR=0.0.0.0:8611
ENTRYPOINT ["bridge-host"]
CMD ["run"]
