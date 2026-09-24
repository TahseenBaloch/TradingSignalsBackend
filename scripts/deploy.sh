#!/usr/bin/env bash
# Runs on the droplet once the checkout is at origin/main (see .github/workflows/deploy.yml): install, restart. Settings come from .env, which git never touches.
set -euo pipefail
cd "$(dirname "$0")/.."

npm ci
pm2 restart backend
pm2 save
