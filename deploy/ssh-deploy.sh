#!/usr/bin/env bash
# Forced command for the GitHub Actions deploy key (docs/DEPLOY.md §12). In ~/.ssh/authorized_keys:
#   command="/home/deploy/worldforge/deploy/ssh-deploy.sh",restrict ssh-ed25519 AAAA… github-deploy
# The key can then only run `deploy` or `deploy <40-hex commit>`, nothing else.
set -euo pipefail
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
request=${SSH_ORIGINAL_COMMAND:-}
if [[ $request =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  exec "$dir/deploy.sh" --ref "${BASH_REMATCH[1]}"
elif [[ $request == deploy ]]; then
  exec "$dir/deploy.sh"
fi
echo "refused: only 'deploy [<commit sha>]' is allowed for this key" >&2
exit 1
