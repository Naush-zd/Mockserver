FROM node:20-slim

RUN apt-get update && apt-get install -y curl jq && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY server.cjs ./
COPY src/ ./src/
COPY import-to-microcks.sh ./
COPY entrypoint.sh ./

# Bake the Git-tracked artifacts into the image as a read-only seed. At
# container startup the entrypoint copies them into /app/artifacts (which is
# expected to be a writable, persistent volume in production).
COPY artifacts/ ./artifacts-seed/

RUN chmod +x import-to-microcks.sh entrypoint.sh

EXPOSE 4010

ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "server.cjs"]
