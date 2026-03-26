#!/usr/bin/env bash
#
# Cleanup orphaned test processes
# ARCHITECTURE: Only kills processes spawned by Autobeat tests, not user's Claude instances
#

set -euo pipefail

echo "🧹 Cleaning up orphaned test processes..."

# Only kill processes with AUTOBEAT_WORKER=true environment variable
# This ensures we don't kill user's active Claude Code instances
pgrep -f "claude.*--print" | while read -r pid; do
  # Check if process has AUTOBEAT_WORKER env var
  if grep -q "AUTOBEAT_WORKER=true" "/proc/$pid/environ" 2>/dev/null; then
    echo "  Killing test worker PID: $pid"
    kill -TERM "$pid" 2>/dev/null || true
  fi
done

# Clean up test databases
echo "🧹 Cleaning up test databases..."
rm -rf test-db/*.db test-db/*.db-wal test-db/*.db-shm 2>/dev/null || true

# Clean up test logs
echo "🧹 Cleaning up test logs..."
rm -rf test-logs/* 2>/dev/null || true

echo "✅ Cleanup complete"
