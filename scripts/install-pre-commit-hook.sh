#!/usr/bin/env bash
# Install a pre-commit hook that runs the secret scan on staged files.
# Usage: ./scripts/install-pre-commit-hook.sh

set -euo pipefail

HOOK_DIR="$(git rev-parse --git-path hooks)"
HOOK="$HOOK_DIR/pre-commit"

cat > "$HOOK" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
exec "$ROOT/scripts/check-secrets.sh" --staged
EOF

chmod +x "$HOOK"
echo "installed pre-commit hook at $HOOK"
