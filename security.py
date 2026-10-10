"""
Adonai Store — Security Primitives
Centralizes credential hashing (PBKDF2), constant-time comparisons,
JWT signing-secret management, request rate limiting, and input sanitization.

All helpers use only the Python standard library so no new runtime
dependencies are introduced.
"""
import base64
import hashlib
import hmac
import logging
import os
import re
import secrets
import threading
import time
from collections import deque

logger = logging.getLogger("adonai.security")

# ============================================================================
# Password / PIN hashing — PBKDF2-HMAC-SHA256 with per-credential random salt
# ============================================================================
PBKDF2_ALGORITHM = "pbkdf2_sha256"
PBKDF2_ITERATIONS = 600_000          # OWASP 2023+ recommendation for PBKDF2-SHA256
PBKDF2_SALT_BYTES = 16
PBKDF2_KEY_BYTES = 32

_LEGACY_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def hash_pin(pin: str, iterations: int = PBKDF2_ITERATIONS) -> str:
    """Hash a staff PIN/passphrase with PBKDF2-HMAC-SHA256 and a random salt.

    Format: pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>
    """
    if pin is None:
        raise ValueError("PIN must not be empty")
    salt = secrets.token_bytes(PBKDF2_SALT_BYTES)
    derived = hashlib.pbkdf2_hmac(
        "sha256", str(pin).encode("utf-8"), salt, iterations, dklen=PBKDF2_KEY_BYTES
    )
    return "$".join([
        PBKDF2_ALGORITHM,
        str(iterations),
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(derived).decode("ascii"),
    ])


def verify_pin(candidate: str, stored_hash: str) -> bool:
    """Constant-time verification of a candidate PIN against a stored hash.

    Supports the current PBKDF2 format and (read-only) legacy unsalted
    SHA-256 hex digests so already-deployed databases keep working. Legacy
    hashes should be transparently upgraded on successful login via
    needs_rehash().
    """
    if not candidate or not stored_hash:
        return False
    stored_hash = str(stored_hash).strip()
    candidate_bytes = str(candidate).encode("utf-8")

    if stored_hash.startswith(PBKDF2_ALGORITHM + "$"):
        try:
            _, iter_s, salt_b64, hash_b64 = stored_hash.split("$", 3)
            iterations = int(iter_s)
            salt = base64.b64decode(salt_b64)
            expected = base64.b64decode(hash_b64)
        except (ValueError, TypeError):
            return False
        derived = hashlib.pbkdf2_hmac(
            "sha256", candidate_bytes, salt, iterations, dklen=len(expected)
        )
        return hmac.compare_digest(derived, expected)

    # Legacy unsalted SHA-256 digest (pre-hardening deployments only).
    if _LEGACY_SHA256_RE.match(stored_hash.lower()):
        digest = hashlib.sha256(candidate_bytes).hexdigest()
        return hmac.compare_digest(digest.encode("ascii"), stored_hash.lower().encode("ascii"))

    return False


def needs_rehash(stored_hash: str) -> bool:
    """True when a stored credential hash should be upgraded to PBKDF2."""
    if not stored_hash:
        return False
    stored_hash = str(stored_hash).strip()
    if not stored_hash.startswith(PBKDF2_ALGORITHM + "$"):
        return True
    try:
        _, iter_s, _, _ = stored_hash.split("$", 3)
        return int(iter_s) < PBKDF2_ITERATIONS
    except (ValueError, TypeError):
        return True


def constant_time_equals(a: str, b: str) -> bool:
    """Timing-safe string equality for secrets/keys."""
    if a is None or b is None:
        return False
    return hmac.compare_digest(str(a).encode("utf-8"), str(b).encode("utf-8"))


# ============================================================================
# JWT signing secret — env-provided, else persisted random secret (0600 file)
# ============================================================================
_SECRET_FILE_NAME = ".jwt_secret"


def load_or_create_jwt_secret(root_dir: str) -> str:
    """Resolve the JWT signing secret.

    Priority:
      1. JWT_SECRET environment variable (recommended for production — keeps
         sessions valid across deploys and worker restarts).
      2. A locally persisted, randomly generated 256-bit secret stored with
         0600 permissions in the application directory (gitignored). This
         guarantees that NO hardcoded or guessable fallback secret ever signs
         authentication tokens.
    """
    env_secret = os.environ.get("JWT_SECRET", "").strip()
    if env_secret:
        if len(env_secret) < 16:
            logger.warning(
                "JWT_SECRET is shorter than 16 characters — use a long random value."
            )
        return env_secret

    secret_path = os.path.join(root_dir, _SECRET_FILE_NAME)
    try:
        with open(secret_path, "r", encoding="utf-8") as fh:
            existing = fh.read().strip()
            if existing:
                return existing
    except FileNotFoundError:
        pass
    except OSError as err:
        logger.warning("Could not read persisted JWT secret: %s", err)

    new_secret = secrets.token_urlsafe(48)
    try:
        # Exclusive create avoids a race between gunicorn workers.
        fd = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(new_secret)
        logger.warning(
            "JWT_SECRET env var not set — generated a random signing secret at %s. "
            "Set JWT_SECRET in the environment for stable sessions across deploys.",
            secret_path,
        )
        return new_secret
    except FileExistsError:
        # Another worker won the race — read its value.
        try:
            with open(secret_path, "r", encoding="utf-8") as fh:
                return fh.read().strip() or new_secret
        except OSError:
            return new_secret
    except OSError as err:
        logger.warning(
            "Could not persist generated JWT secret (%s). Using in-memory secret; "
            "set JWT_SECRET in the environment.", err
        )
        return new_secret


# ============================================================================
# Rate limiting — thread-safe in-memory sliding window (per worker process)
# ============================================================================
class RateLimiter:
    """Sliding-window limiter guarding against brute force and request floods."""

    MAX_TRACKED_KEYS = 20_000

    def __init__(self):
        self._hits: dict[tuple[str, str], deque] = {}
        self._lock = threading.Lock()

    def check(self, bucket: str, key: str, limit: int, window_seconds: float) -> tuple[bool, int]:
        """Returns (allowed, retry_after_seconds)."""
        now = time.monotonic()
        composite = (bucket, str(key or "unknown"))
        with self._lock:
            if len(self._hits) > self.MAX_TRACKED_KEYS:
                self._evict_stale(now, window_seconds)
            q = self._hits.get(composite)
            if q is None:
                q = deque()
                self._hits[composite] = q
            cutoff = now - window_seconds
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= limit:
                retry_after = max(1, int(q[0] + window_seconds - now) + 1)
                return False, retry_after
            q.append(now)
            return True, 0

    def peek(self, bucket: str, key: str, limit: int, window_seconds: float) -> tuple[bool, int]:
        """Like check(), but read-only: reports whether the bucket is currently
        exhausted without consuming a slot. Use it before a credential check and
        call check() only for failed attempts, so successful sign-ins never
        count against the brute-force budget."""
        now = time.monotonic()
        composite = (bucket, str(key or "unknown"))
        with self._lock:
            q = self._hits.get(composite)
            if not q:
                return True, 0
            cutoff = now - window_seconds
            live = [t for t in q if t > cutoff]
            if len(live) >= limit:
                retry_after = max(1, int(live[0] + window_seconds - now) + 1)
                return False, retry_after
            return True, 0

    def _evict_stale(self, now: float, window_seconds: float) -> None:
        cutoff = now - max(window_seconds, 3600)
        stale = [k for k, q in self._hits.items() if not q or q[-1] <= cutoff]
        for k in stale:
            del self._hits[k]


def rate_limiting_disabled() -> bool:
    return os.environ.get("ADONAI_RATE_LIMIT_DISABLED", "") == "1"


def get_client_ip(headers: dict | None, fallback: str = "") -> str:
    """Best-effort client address: first X-Forwarded-For hop (set by the
    Render/HTTPS proxy) falling back to the socket peer address."""
    headers = headers or {}
    forwarded = str(headers.get("x-forwarded-for", "") or "").split(",")[0].strip()
    if forwarded:
        return forwarded[:64]
    real_ip = str(headers.get("x-real-ip", "") or "").strip()
    if real_ip:
        return real_ip[:64]
    return str(fallback or "unknown")[:64]


# ============================================================================
# Input sanitization helpers
# ============================================================================
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")


def clean_text(value, max_len: int = 255) -> str:
    """Normalize untrusted text input: cast to str, drop control characters,
    collapse CR/LF where single-line values are expected, trim, and cap length."""
    text = str(value if value is not None else "")
    text = _CONTROL_CHARS_RE.sub("", text)
    return text.strip()[:max_len]


def clean_multiline_text(value, max_len: int = 2000) -> str:
    """Like clean_text but preserves newlines for notes/description fields."""
    text = str(value if value is not None else "")
    text = _CONTROL_CHARS_RE.sub("", text)
    return text.strip()[:max_len]


def safe_identifier(value) -> str | None:
    """Validate a client-supplied identifier (order/lock IDs): alphanumeric,
    dash and underscore only. Returns the ID or None when invalid."""
    candidate = str(value or "").strip()
    if SAFE_ID_RE.match(candidate):
        return candidate
    return None


DATA_IMAGE_MAX_LEN = 4_000_000  # ~3 MB photo as base64


def safe_image_url(value, max_len: int = 1000) -> str:
    """Only allow http(s) URLs, data:image/* payloads (camera intake photos),
    or relative asset paths for image references — rejects javascript:,
    data:text/html and every other dangerous scheme."""
    url = str(value if value is not None else "").strip()
    if not url:
        return ""
    lowered = url.lower()
    if lowered.startswith("data:image/"):
        # Base64 camera photos from POS intake; control chars are invalid here.
        if _CONTROL_CHARS_RE.search(url):
            return ""
        return url[:DATA_IMAGE_MAX_LEN]
    url = clean_text(url, max_len)
    lowered = url.lower()
    if lowered.startswith(("http://", "https://")):
        return url
    if lowered.startswith(("assets/", "./assets/", "/assets/")):
        return url
    return ""
