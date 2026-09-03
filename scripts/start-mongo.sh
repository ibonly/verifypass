#!/usr/bin/env bash
set -e

# VerifyPass MongoDB Replica Set Helper for macOS
DATA_DIR="/opt/homebrew/var/mongodb"
LOG_DIR="/opt/homebrew/var/log/mongodb"
LOG_FILE="$LOG_DIR/mongo-rs.log"

mkdir -p "$DATA_DIR" "$LOG_DIR"

# Check if mongod is running with replication
needs_restart=false
if pgrep -x "mongod" > /dev/null; then
  is_rs=$(mongosh --quiet --eval 'try { const s = rs.status(); print(s.ok === 1 ? "yes" : "no"); } catch(e) { print("no"); }' 2>/dev/null || echo "no")
  if [[ "$is_rs" != *"yes"* ]]; then
    echo "Existing mongod is running without replica set enabled. Restarting with --replSet rs0..."
    pkill -x mongod || true
    sleep 2
    needs_restart=true
  else
    echo "mongod is already running with replica set enabled."
  fi
else
  needs_restart=true
fi

if [ "$needs_restart" = true ]; then
  echo "Starting mongod with replica set 'rs0' in background..."
  nohup mongod --dbpath "$DATA_DIR" --replSet rs0 > "$LOG_FILE" 2>&1 &
  sleep 3
  echo "Initiating replica set 'rs0'..."
  mongosh --quiet --eval '
    try {
      rs.initiate();
      print("Initiated replica set rs0 successfully.");
    } catch (e) {
      if (e.codeName === "AlreadyInitialized" || String(e).includes("already initialized")) {
        print("Replica set already initialized.");
      } else {
        print("Init message:", e.message || e);
      }
    }
  ' || true
fi

echo "Applying Prisma schema..."
(cd "$(dirname "$0")/../backend" && npm run prisma:push)

echo "✅ MongoDB replica set is ready and schema applied!"
