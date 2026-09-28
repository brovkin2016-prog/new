FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm install
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine
WORKDIR /app
# ts-node нужен для `prisma db seed`, поэтому ставим все зависимости
COPY package*.json ./
COPY prisma ./prisma
RUN npm install && npx prisma generate
COPY tsconfig.json ./
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main.js"]
