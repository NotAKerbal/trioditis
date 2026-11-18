# The bridge host (Go). Built with cgo: the bridge framework links SQLite, even though
# installs keep the bridge database on Postgres.
FROM golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS build

WORKDIR /src
COPY go.work go.work.sum ./
COPY apps/bridge-host/go.mod apps/bridge-host/go.sum apps/bridge-host/
RUN --mount=type=cache,target=/go/pkg/mod cd apps/bridge-host && go mod download
COPY apps/bridge-host apps/bridge-host
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
  cd apps/bridge-host && CGO_ENABLED=1 go build -trimpath -ldflags='-s -w' -o /out/bridge-host ./cmd/bridge-host

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --create-home bridge \
  && mkdir -p /data && chown bridge:bridge /data
COPY --from=build /out/bridge-host /usr/local/bin/bridge-host

USER bridge
ENV BRIDGE_DATA_DIR=/data BRIDGE_HOST_ADDR=0.0.0.0:8611
ENTRYPOINT ["bridge-host"]
CMD ["run"]
