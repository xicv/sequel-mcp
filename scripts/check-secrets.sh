#!/usr/bin/env bash
# Local secret-scan: regex sweep over the working tree (or staged diff with --staged).
# Exits non-zero on any match. Designed to be cheap enough for a pre-commit hook.

set -uo pipefail

if [[ "${1:-}" == "--staged" ]]; then
  TARGET="$(git diff --cached --name-only --diff-filter=ACMR | tr '\n' ' ')"
  if [[ -z "${TARGET// }" ]]; then
    echo "no staged files"
    exit 0
  fi
  GREP() { git diff --cached -U0 -- $TARGET | grep -nE "$1"; }
else
  GREP() {
    grep -rInE \
      --exclude-dir=node_modules \
      --exclude-dir=dist \
      --exclude-dir=fixtures \
      --exclude-dir=coverage \
      --exclude-dir=.git \
      --exclude=package-lock.json \
      --exclude=*.lock \
      "$1" .
  }
fi

FAIL=0
check() {
  local label="$1"; local pattern="$2"
  local hits
  hits="$(GREP "$pattern" || true)"
  if [[ -n "$hits" ]]; then
    echo
    echo "::: $label :::"
    echo "$hits"
    FAIL=1
  fi
}

check "AWS access keys" 'AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}'
check "GitHub tokens"   'ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|gho_[A-Za-z0-9]{30,}|ghs_[A-Za-z0-9]{30,}'
check "Google OAuth"    'GOCSPX-[A-Za-z0-9_-]{20,}'
check "Slack tokens"    'xox[baprs]-[A-Za-z0-9-]{10,}'
check "Stripe keys"     'sk_live_[A-Za-z0-9]{20,}|rk_live_[A-Za-z0-9]{20,}'
check "Private keys"    'BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY'
check "JWT-ish tokens"  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'
check "User home paths" '/Users/[a-zA-Z][a-zA-Z0-9_.-]+|/home/[a-zA-Z][a-zA-Z0-9_.-]+'
check "Generic password assignments" '(password|passwd|pwd)\s*[:=]\s*["'\''][^"'\'' ]{6,}["'\'']'
check "Bearer tokens" 'Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}'

if [[ $FAIL -ne 0 ]]; then
  echo
  echo "Secret scan FAILED. Remove the matches above before committing."
  exit 1
fi
echo "secret scan: clean"
exit 0
