FROM oven/bun:latest

# Metadata
LABEL name="vidstream-server" \
      version="1.0.0" \
      description="Backend of Vidstream, a website where you can upload videos to watch them live with your friends!"

# Environment variables
ENV NODE_ENV=production

# Install necessary system dependencies and clean up cache
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Clone from the GitHub repository
ARG BRANCH=main
RUN git clone --branch ${BRANCH} https://github.com/M336G/vidstream-server.git . && \
    git checkout ${BRANCH}

# Install dependencies while skipping development dependencies
RUN rm -f package-lock.json bun.lockb bun.lock && \
    bun install --omit=dev --production

# Set a non-root user for security (create one if needed)
RUN addgroup --system vidstreamgroup && \
    adduser --system --ingroup vidstreamgroup vidstreamuser && \
    chown -R vidstreamuser:vidstreamgroup /app
USER vidstreamuser

# Expose the port for the application
EXPOSE 4949/tcp

# Entrypoint and command
ENTRYPOINT ["bun"]
CMD ["start"]
