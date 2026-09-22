# Satchel, as one image: the built app and every endpoint on one port.
#
# Production is still Vercel plus hosted Supabase and nothing here changes
# that. This exists so the system can be run and measured on one machine, and
# so deploying it somewhere else stays possible rather than becoming a
# rewrite.
FROM node:22-alpine AS build
WORKDIR /app
# The lockfile alone first, so a change to source does not reinstall.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# The endpoints import @supabase/supabase-js, the AI SDK and the Langfuse
# packages at runtime, so this is not a static bundle and the production tree
# has to come with it.
RUN npm ci --omit=dev
COPY api ./api
COPY server ./server
COPY scripts ./scripts
COPY vercel.json ./vercel.json
COPY --from=build /app/dist ./dist
# Nothing in here needs root.
USER node
EXPOSE 3000
ENV PORT=3000
CMD ["node", "scripts/serve.mjs"]
