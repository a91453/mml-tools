FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./package.json
COPY dist/core.js ./dist/core.js
COPY server/mcp.mjs ./server/mcp.mjs
COPY railway/auth.mjs railway/server.mjs ./railway/
ENV NODE_ENV=production PORT=3000 MML_AUTH_DB=/data/mml-auth.sqlite
EXPOSE 3000
CMD ["node", "railway/server.mjs"]
