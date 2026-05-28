# Stage 1: Build React/Vite Frontend
FROM node:20-slim AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# Stage 2: Production Server Environment
FROM node:20-slim
WORKDIR /app

# Install native compilation dependencies for SQLite3 package if needed
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY config/ ./config/
COPY services/ ./services/
COPY server.js ./

# Copy local SQLite DB and uploads into bootstrap_data for seeding on first boot
COPY neet_pg_bank_v2.db ./bootstrap_data/neet_pg_bank_v2.db
COPY public/uploads/ ./bootstrap_data/uploads/

# Copy compiled static assets from client builder stage
COPY --from=client-builder /app/client/dist ./client/dist

# Expose backend port and set production environment configuration
ENV NODE_ENV=production
ENV PORT=5000
ENV DATABASE_PATH=/data/neet_pg_bank_v2.db
ENV UPLOAD_DIR=/data/uploads

EXPOSE 5000

# Ensure persistent mount directory exists locally inside the container
RUN mkdir -p /data

CMD ["node", "server.js"]
