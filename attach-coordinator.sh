#!/bin/sh
# Keeps a herdr pane on its space's coordinator. The sync writes the coordinator's
# address to the file named by $1 (empty while there is none) and never types into
# this pane again: a restarted coordinator, or a detach with ctrl+\, is attached here.
while :; do
  address=$(cat "$1" 2>/dev/null)
  [ -n "$address" ] && "$HC" attach "$address"
  sleep 10
done
