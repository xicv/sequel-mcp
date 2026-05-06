# Contributing to sequel-mcp

Thanks for considering a contribution. This project handles real database credentials, so the contribution rules are stricter than usual around what may enter the repository.

## The Cardinal Rule

**No credential, no PII, no environment-specific identifier may ever enter this repository — not in source code, not in tests, not in commit messages, not in screenshots in PRs.**

If you suspect you've committed something sensitive, see "I think I leaked something" below.

## What you may NOT commit

| Category | Examples |
|---|---|
| Passwords / tokens | Any password literal, API keys, JWTs, OAuth tokens, AWS access keys, GitHub PATs, Slack tokens. |
| Private keys | `id_rsa`, `id_ed25519`, any `*.pem` / `*.key` / `*.p12`. |
| Real hostnames | Real DB hosts, internal bastions, VPN endpoints, jumpboxes, `*.internal`, `*.corp`, `*.local`. |
| Real database/schema names that identify a customer or org | `acme_prod`, `customer_pii`. |
| User home paths | `/Users/<name>/...`, `/home/<name>/...`. |
| Personal email addresses or full names | Anywhere outside the standard contributor signoff. |
| Screenshots that include any of the above | PR descriptions and discussions included. |

## What you may use in tests

- **Hostnames**: only `example.com`, `example.org`, `example.net`, `localhost`, `127.0.0.1` (IETF-reserved per RFC 2606).
- **DB names**: generic placeholders like `app`, `analytics`, `test_db`.
- **User names**: generic placeholders like `root`, `readonly`, `dbuser`.
- **Synthetic plist/config blobs**: any `Favorites.plist`-shaped fixture must be hand-written with placeholders, never copy-pasted from a real Sequel Ace install.

## Pre-commit checklist

Run before every commit:

```bash
./scripts/check-secrets.sh         # local regex scan
npm run typecheck                  # tsc --noEmit
npm run lint                       # eslint on src + tests
npm test                           # vitest run (currently 34 cases)
```

Optional but recommended: install [`gitleaks`](https://github.com/gitleaks/gitleaks) and run it against your staged diff:

```bash
brew install gitleaks
git diff --cached | gitleaks detect --no-git -v
```

## Coding rules

- TypeScript strict mode. No `any` without explicit justification.
- New features need tests for the safety-critical layers (classifier, gate, importer).
- AST classifier remains **closed-world** — never extend `categorize()` with an `else → admin` fallback. Unknown statement types must remain unknown.
- Never add an `allow` or `deny` shortcut that bypasses the policy gate. All SQL goes through `evaluatePolicy()`.
- Never log raw credentials or full SQL containing literal values that may be PII. Stderr `log()` in `executor.ts` truncates SQL to 120 chars and excludes parameter values — keep it that way.
- New tools must declare `annotations` honestly (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).

## I think I leaked something

1. Stop. Do not push.
2. If you've already committed locally but not pushed:
   ```bash
   git reset --soft HEAD~1
   # remove the secret from the file
   ./scripts/check-secrets.sh
   git commit -c ORIG_HEAD
   ```
3. If you've already pushed: assume the credential is compromised. **Rotate it immediately.** Then scrub history with `git filter-repo` (or `git filter-branch` as a fallback) and force-push, after coordinating with maintainers.

A leaked credential cannot be "deleted" from a public repo — it has been crawled within minutes by automated scanners. Rotation is the only real fix.

## License

By submitting a PR you agree your contribution is licensed under MIT (see `LICENSE`).
