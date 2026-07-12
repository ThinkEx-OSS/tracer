# Cloudflare Containers currently execute AMD64 images. Pin both stages so an
# Apple Silicon workstation cannot build an ARM64 Node layer around the AMD64
# Sandbox control binary.
ARG SANDBOX_PLATFORM=linux/amd64
FROM --platform=${SANDBOX_PLATFORM} docker.io/cloudflare/sandbox:0.12.3 AS sandbox-runtime

FROM --platform=${SANDBOX_PLATFORM} docker.io/library/node:24-bookworm-slim

ARG THINKEX_REPOSITORY=https://github.com/ThinkEx-OSS/thinkex.git
ARG THINKEX_REF=main
ARG THINKEX_DIRECTORY=/workspace/repositories/thinkex

# Add the Sandbox API to a native Node 24 image instead of carrying the base
# image's Node 22 runtime alongside a second Node installation.
COPY --from=sandbox-runtime /container-server/sandbox /sandbox

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential \
		ca-certificates \
		curl \
		git \
		jq \
		python3 \
		ripgrep \
	&& npm install --global --no-audit --no-fund pnpm@11.7.0 \
	&& rm -rf /var/lib/apt/lists/*

# A fresh investigation starts with a real ThinkEx checkout and its locked
# dependency graph. Runtime bootstrap only fetches the newest base commit; it
# reinstalls when (and only when) the package inputs changed.
RUN git clone --depth 1 --single-branch --branch "${THINKEX_REF}" "${THINKEX_REPOSITORY}" "${THINKEX_DIRECTORY}" \
	&& cd "${THINKEX_DIRECTORY}" \
	&& CI=true pnpm install --frozen-lockfile

# Cloudflare's local container runtime discovers the Sandbox control server
# through this declared port.
EXPOSE 3000

ENTRYPOINT ["/sandbox"]
