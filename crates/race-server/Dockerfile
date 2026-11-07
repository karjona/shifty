# Race server image: static-ish Rust binary on distroless (~25 MB).
# Build from the repo root:
#   docker build -f crates/race-server/Dockerfile -t shifty-race-server .
#   container build -f crates/race-server/Dockerfile -t shifty-race-server .   # Apple container
# Run (hash mode, no domain needed):
#   docker run -p 4433:4433/udp -e LOBBY_PUBLIC_KEY=... -e PUBLIC_ADDR=host:4433 shifty-race-server
# UDP 4433 carries all game traffic (WebTransport). TCP 4433 is ops HTTP only
# (/healthz, /metrics, /cert-hash): add -p 4433:4433/tcp to reach it locally,
# never publish it in production. The health check runs inside the container.

FROM rust:1.99-slim-trixie@sha256:b8e062b1c3a80183df83d9ba187cadd2b5ab84bc78d453dbfeb2fccd5f982247 AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake curl && rm -rf /var/lib/apt/lists/*

# cargo-about renders the third-party license notices shipped in the image.
ARG CARGO_ABOUT_VERSION=0.9.3
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) triple=x86_64-unknown-linux-musl; sha=3ad1e94ea1e63d69d1961f4fb15ccbbe9575d906111f96d2cb4dce6df48f71b4 ;; \
      aarch64) triple=aarch64-unknown-linux-musl; sha=eb4d9ff6ebd2518152a8308729431a04b3836e71d2bd5ead7aea69f91a71162e ;; \
      *) echo "no cargo-about build for $(uname -m)" >&2; exit 1 ;; \
    esac; \
    name="cargo-about-${CARGO_ABOUT_VERSION}-${triple}"; \
    curl -fsSL -o /tmp/cargo-about.tar.gz \
      "https://github.com/EmbarkStudios/cargo-about/releases/download/${CARGO_ABOUT_VERSION}/${name}.tar.gz"; \
    echo "${sha}  /tmp/cargo-about.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/cargo-about.tar.gz -C /usr/local/cargo/bin --strip-components=1 "${name}/cargo-about"; \
    rm /tmp/cargo-about.tar.gz

WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p race-server && cp target/release/race-server /race-server && \
    cargo about generate --locked --fail -m crates/race-server/Cargo.toml \
      --target "$(rustc -vV | sed -n 's/^host: //p')" -o /THIRD-PARTY-NOTICES.md about.hbs

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:08476c244888bfb425bae1ae4dd7c17f093e972aab8426883d97f3c6f280f7c1
LABEL org.opencontainers.image.source="https://github.com/karjona/shifty" \
      org.opencontainers.image.description="23.4° Shifty race server: WebTransport rooms on UDP 4433" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build /race-server /race-server
# Apache-2.0 §4: redistributions carry the license, our NOTICE and the notices of bundled crates.
COPY --from=build /src/LICENSE /src/NOTICE /THIRD-PARTY-NOTICES.md /usr/share/doc/shifty/
ENV BIND=[::]:4433 \
    RUST_LOG=info
EXPOSE 4433/udp
USER nonroot
# GETs /healthz on the ops port; unhealthy while draining (503).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["/race-server", "healthcheck"]
ENTRYPOINT ["/race-server"]
