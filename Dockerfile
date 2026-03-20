FROM node:20-bookworm AS builder

RUN apt-get update && apt-get install -y \
    curl \
    xz-utils \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
RUN curl -L https://ziglang.org/download/0.15.2/zig-x86_64-linux-0.15.2.tar.xz -o zig.tar.xz \
    && tar -xf zig.tar.xz \
    && mv zig-x86_64-linux-0.15.2 zig \
    && ln -s /opt/zig/zig /usr/local/bin/zig

WORKDIR /src
COPY . .

RUN cd webui && npm install
RUN zig build -Dtarget=x86_64-linux -Doptimize=ReleaseSafe

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /src/zig-out/bin/zed2api /app/zed2api
COPY accounts.example.json /app/accounts.example.json

EXPOSE 8000
VOLUME ["/app/data"]

ENV ZED2API_PORT=8000

CMD ["/bin/sh", "-c", "cp -n /app/accounts.example.json /app/data/accounts.json 2>/dev/null || true; cd /app/data && /app/zed2api serve ${ZED2API_PORT}"]
