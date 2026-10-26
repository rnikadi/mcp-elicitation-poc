# One Node image for the server, terminal client and web backend; docker-compose
# picks the command per service. The `web` stage is the frontend (nginx).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM nginx:1.29-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist-web /usr/share/nginx/html
EXPOSE 8080

# Last stage, so a plain `docker build .` gives the Node image.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server/main.js"]
