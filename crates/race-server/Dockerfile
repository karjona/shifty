# Race server image: static-ish Rust binary on distroless (~25 MB).
# Build from the repo root:
#   docker build -f crates/race-server/Dockerfile -t shifty-race-server .
#   container build -f crates/race-server/Dockerfile -t shifty-race-server .   # Apple container
# Run (hash mode, no domain needed):
#   docker run -p 443:443/udp -p 443:443/tcp -e LOBBY_PUBLIC_KEY=... -e PUBLIC_ADDR=host:443 shifty-race-server
# UDP 443 carries all game traffic (WebTransport); TCP 443 is ops HTTP only
# (/healthz, /metrics, /cert-hash).

FROM rust:1.99-slim-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p race-server && cp target/release/race-server /race-server

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /race-server /race-server
# Apache-2.0 §4: redistributions carry the license and our NOTICE.
COPY --from=build /src/LICENSE /src/NOTICE /usr/share/doc/shifty/
ENV BIND=[::]:443 \
    RUST_LOG=info
EXPOSE 443/udp 443/tcp
USER nonroot
ENTRYPOINT ["/race-server"]
