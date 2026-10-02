# Adonai Store — Security Audit & Hardening Report

**Date:** 2026-10-02 · **Scope:** full application (Python WSGI backend, web storefront/POS/admin frontend, Android/Capacitor shell, CI, repository history)

Legend: 🔴 Critical · 🟠 High · 🟡 Medium · 🔵 Low/Info · ✅ Fixed in this pass

---

## 1. Secrets & Credentials

### 1.1 Git history scan — ✅ clean
- The repository history (single squashed root commit) was scanned for private keys,
  API tokens, cloud credentials (AWS/GCP/Stripe/Slack/GitHub token patterns),
  connection strings with embedded passwords, and sensitive filenames
  (`.env`, `*.pem`, `*.keystore`, `id_rsa`, …). **No real secrets were found in history.**
- CI (`.github/workflows/build-pos-apk.yml`) correctly consumes signing material from
  **GitHub encrypted secrets**, never from the repo.

### 1.2 🔴 Hardcoded backdoor master key — ✅ removed
`ADONAI-MASTER-2026` was accepted as a full-admin credential in **four** places:
server `is_authenticated_staff()`, server `/api/auth/verify`, the seeded
`master_key` store setting, and the client (`js/db.js` `verifyMasterKey` +
the admin UI even displayed it). Anyone reading the public repo had admin access.
- Removed from server auth paths and client; the value is now on a permanent
  **blocklist** (`RETIRED_DEFAULT_KEYS`) so it can never authenticate again.
- `db_init.py` now **purges** the retired value from existing databases on boot.
- `/api/settings` refuses to set a master/admin key back to the retired value.
- Regression test added (`test_06`, step 5).

### 1.3 🔴 Hardcoded / low-entropy JWT signing secret — ✅ fixed
`JWT_SECRET` fell back to the admin PIN (6 digits — offline-forgeable tokens) and
finally to a hardcoded string committed to the repo.
- Now: `JWT_SECRET` env var, else a **random 384-bit secret** generated and persisted
  to a gitignored `0600` file (`.jwt_secret`), race-safe across gunicorn workers.
  No hardcoded fallback exists. Session TTL reduced 30 d → 7 d (configurable
  via `JWT_TTL_SECONDS`).

### 1.4 🟠 Real-looking credentials in `.env.example` — ✅ replaced
`ADMIN_ACCESS_PIN=246810`, `STAFF_TERMINAL_KEY=ADONAI-POS-2026` and a GA ID were
committed as "examples". All replaced with `CHANGE_ME…` placeholders; `JWT_SECRET`
documented with a generation command.

### 1.5 Environment hygiene — ✅ verified/extended
- `.env` was already gitignored; `.gitignore` extended with `.env.*` (except
  `.env.example`), `.jwt_secret`, `*.pem`, `*.key`, `secrets/`. No `.env` file is
  tracked. `render.yaml` keeps secrets as `sync: false` (dashboard-managed). ✅
- API keys exist **only** server-side (env vars); the client never receives them —
  `/api/settings` GET serializes a strict public allowlist (`PUBLIC_STORE_SETTING_KEYS`),
  verified by `test_08`.

### 1.6 🔴 Exposed sensitive files over HTTP — ✅ fixed
The static file server resolved *any* path under the repo root: `/api.py`,
`/serve.py`, `/requirements.txt`, `/.git/config`, `/render.yaml`, `/scripts/*`,
etc. were all downloadable, and `os.path.join` permitted `..` traversal.
- New `resolve_static_file()` (used by both the WSGI app and the standalone server):
  rejects `..`/hidden segments, enforces a **realpath containment** check, a
  **file-extension allowlist**, a **blocked-directory list** (`.git`, `.github`,
  `android`, `scripts`, `migrations`, `pos-dist`, …) and a blocked-filename list
  (`requirements.txt`, `package.json`, …).
- Verified live: 16 sensitive paths → 404; traversal (`/../etc/passwd`, encoded) → 404;
  all legitimate pages/assets still 200.

## 2. Authentication, Authorization & Access Control

### 2.1 🔴 Password/PIN hashing — ✅ upgraded to salted PBKDF2
PINs were stored as **unsalted SHA-256**, and the login query matched
`pin_hash == candidate` — i.e. presenting the *hash itself* logged you in
(pass-the-hash), and 4-digit PINs were trivially crackable from a DB dump.
- New `security.py`: **PBKDF2-HMAC-SHA256, 600,000 iterations, 128-bit random salt**
  (OWASP-recommended), constant-time verification. Legacy SHA-256 hashes still verify
  once and are **transparently re-hashed to PBKDF2 on successful login**.
- Pass-the-hash comparison removed entirely.

### 2.2 🟠 Credentials in URL query strings — ✅ removed
`?token=` / `?key=` authentication leaked credentials into access logs, proxies,
browser history and `Referer` headers. Server no longer accepts query-string
credentials (clients already used headers only). Regression-tested in `test_05`.

### 2.3 🟡 Weak comparisons — ✅ fixed
Key checks were case-insensitive and non-constant-time. All env/settings key
comparisons now use `hmac.compare_digest` with exact matching; candidate length
is capped (1 KB) to bound work.

### 2.4 🟠 Demo accounts with weak PINs seeded in production — ✅ gated
`1234/2345/3456/4567` staff accounts are now seeded **only** on local SQLite
development databases (or with explicit `ADONAI_SEED_DEMO_USERS=1`); production
PostgreSQL deployments start with no default credentials.

### 2.5 RBAC / admin routes — ✅ reviewed
- All mutating/finance endpoints require staff auth; finance dashboards, journal,
  aging and settings writes additionally require `admin`/`manager` roles
  (`authenticated_or_response(manager=True)`, admin-only settings writes). Verified
  by tests 05, 07, 08, 09.
- `/admin`, `/pos` are static shells; every piece of data behind them comes from the
  authenticated API. Failed sign-ins are now logged with the client IP.

### 2.6 Database access — ✅ reviewed
- All queries go through the SQLAlchemy ORM / bound parameters — no string-built SQL
  from user input (the only `text()` DDL uses hardcoded migration strings).
- Credentials live solely in `DATABASE_URL` (Render-injected); URLs are masked in logs.
- `/api/health` no longer discloses table names or pool internals.
- API 500 responses no longer leak exception details (`details: str(err)` removed).

## 3. Application Protection & Hardening

### 3.1 🟠 Rate limiting — ✅ added
New thread-safe sliding-window limiter (`security.py`):
- `/api/auth/verify`: **10 attempts / 5 min / IP** (brute-force guard) → `429` + retry-after.
- All API routes: **300 req / min / IP** flood ceiling.
- Client IP from `X-Forwarded-For` (Render proxy) with socket-address fallback;
  env-tunable (`AUTH_RATE_LIMIT`, `API_RATE_LIMIT`, …). Verified live (429 after limit).

### 3.2 🟡 Input sanitization — ✅ added
- Public order fields (name, phone, address, area, notes) now control-character-stripped
  and length-capped; product intake/update fields likewise.
- Client-supplied order/product IDs validated against `^[A-Za-z0-9_-]{4,64}$`
  (else server-generated); duplicate order IDs → 409.
- `image_url`/`images` restricted to `https?://`, `data:image/*`, or relative
  `assets/` paths — `javascript:` & co. rejected.
- Malformed JSON bodies coerced to `{}`; non-dict bodies rejected; request bodies
  over 5 MB → `413` before buffering.

### 3.3 XSS — ✅ reviewed & tightened
- All dynamic rendering paths use the client `esc()`/`escapeAttr()` HTML-escaping
  helpers; API responses are JSON with `nosniff`.
- CSP tightened: `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'`, `frame-ancestors 'self'` (production), minimal img/font/style
  origins. ⚠️ *Residual risk:* `script-src` retains `'unsafe-inline'` because the UI
  templates rely on inline `onerror` fallback handlers; recommended follow-up is
  refactoring those to `addEventListener` + nonce-based CSP.

### 3.4 CORS — ✅ reviewed
Already restrictive: an explicit allowlist of the native app origins
(`appassets.androidplatform.net`, Capacitor `localhost`) with fixed methods/headers,
`Vary: Origin`, and no wildcard. Unchanged.

### 3.5 Security headers — ✅ present & extended
`Strict-Transport-Security` (preload), `X-Content-Type-Options`, `X-Frame-Options
SAMEORIGIN`, `Referrer-Policy`, `Permissions-Policy`, tightened CSP, and new
`Cross-Origin-Opener-Policy` on **every** response (pages, assets, API, 404s).

### 3.6 Debug/dev flags (per excluded requirement: disabled, nothing removed)
- Capacitor: `webContentsDebuggingEnabled` **true → false**, `cleartext`
  **true → false**, `allowMixedContent` **true → false** (both `.json` and `.ts`).
- AndroidManifest: `usesCleartextTraffic` **true → false**, `allowBackup`
  **true → false**.
- SQLAlchemy `echo=False`; no framework debug mode exists in the WSGI server;
  Android `debuggable true` applies to the debug build type only (standard).

## 4. Maintenance & Audit

### 4.1 Dependencies — ✅ updated (none removed)
- Python floors raised: **gunicorn ≥ 23.0.0** (fixes CVE-2024-1135 /
  CVE-2024-6827 HTTP request smuggling), SQLAlchemy ≥ 2.0.36,
  psycopg2-binary ≥ 2.9.10, psycopg ≥ 3.2.4, typing-extensions ≥ 4.12.2.
- npm: `npm audit` reported **1 critical + 1 high** (transitive `tar` ≤ 7.5.20 under
  `@capacitor/cli`). Fixed non-breakingly via `"overrides": {"tar": "^7.5.22"}` —
  **audit now reports 0 vulnerabilities.** No packages were removed.

### 4.2 Verification performed
- Full test suite: **11/11 passing**, including new regression tests (no schema leak
  in `/api/health`, query-string credential rejection, retired-key rejection).
- Live checks: sensitive-file/traversal blocking, security headers (both preview and
  production modes), auth rate-limit 429, body-size 413, PBKDF2 login + legacy-hash
  upgrade, JWT round-trip, sanitized order creation.
- `pos-dist/` and Android web assets regenerated via `scripts/bundle-pos.js` so the
  client fixes ship in the APK bundle too.

## 5. Recommended follow-ups (not blocking)
1. Set `JWT_SECRET`, a strong `ADMIN_ACCESS_PIN`, and `STAFF_TERMINAL_KEY` in the
   Render dashboard now; rotate any key that matched the old published defaults.
2. Existing production users created with 4-digit PINs should be given longer PINs;
   hashes upgrade automatically at next login.
3. Refactor inline `onerror` handlers so `'unsafe-inline'` can be dropped from
   `script-src`.
4. Note that per-worker in-memory rate limiting multiplies limits by the gunicorn
   worker count (4); move to a shared store (e.g. Redis) if stricter global limits
   are needed.
5. Consider signing release APKs with a dedicated keystore secret (CI already
   supports it) rather than falling back to debug signing.
