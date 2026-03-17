#!/bin/sh
if [ "$1" = "--auth" ]; then
  # Run auth command
  exec node dist/main.js auth
else
  # Default command
  exec node dist/main.js start -g "$GH_TOKEN" "$@"
fi

