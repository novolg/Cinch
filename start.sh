#!/usr/bin/env bash
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "Starting Cinch…"
echo "Local address: http://localhost:3777"

node server.js &
SERVER_PID=$!

sleep 1.2
open "http://localhost:3777"

wait $SERVER_PID
