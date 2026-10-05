#!/usr/bin/env python3
"""
Adonai Store — Production Server & WSGI Gateway for Render
- PostgreSQL Database integration & auto-migration on boot
- Full REST API endpoints under /api/*
- High-concurrency static routing & Gzip compression
- Render deployment compatibility (0.0.0.0 binding, PORT env var)
- Strict security headers (HSTS, CSP, X-Frame-Options, nosniff)
"""
import gzip
import http.server
import io
import logging
import mimetypes
import os
import socketserver
import sys
import urllib.parse

# Setup Database and Auto-Migrations
import notifications
from api import handle_api_request
from database import DATABASE_URL, IS_POSTGRES, mask_database_url, verify_database_connection
from db_init import init_db

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("adonai.server")

ROOT = os.path.dirname(os.path.abspath(__file__))

ROUTES = {
    # Local review sessions may opt into a POS-first root without changing the
    # production storefront route on Render.
    "/": "pos.html" if os.environ.get("ADONAI_PREVIEW_POS_ROOT") == "1" else "index.html",
    "/store": "index.html",
    "/pos": "pos.html",
    "/admin": "admin.html",
    "/login": "login.html",
    "/privacy-policy": "privacy-policy.html",
    "/terms-and-conditions": "terms-and-conditions.html",
    "/sitemap.xml": "sitemap.xml",
    "/robots.txt": "robots.txt",
    "/manifest.json": "manifest.json",
    "/manifest-pos.json": "manifest-pos.json",
    "/download/pos-apk": "dist/adonai-pos-v2.apk",
    "/dist/adonai-pos-v2.apk": "dist/adonai-pos-v2.apk",
    "/adonai-pos.apk": "dist/adonai-pos-v2.apk",
}

COMPRESSIBLE_TYPES = {
    "text/html",
    "text/css",
    "application/javascript",
    "application/json",
    "image/svg+xml",
    "text/plain",
    "application/xml",
    "text/xml",
}

# Ensure correct MIME type registrations
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/manifest+json", ".json")
mimetypes.add_type("application/xml", ".xml")
mimetypes.add_type("application/vnd.android.package-archive", ".apk")


# ALLOW_FRAME_EMBED=1 drops the X-Frame-Options header so sandboxed/preview
# environments can embed the app in an iframe. Production stays SAMEORIGIN.
ALLOW_FRAME_EMBED = os.environ.get("ALLOW_FRAME_EMBED", "") == "1"

# Content Security Policy. NOTE: script-src keeps 'unsafe-inline' because the
# POS/admin UI templates rely on inline event handlers (onerror fallbacks) and
# a small bootstrap inline script; all dynamic output is HTML-escaped via the
# shared esc() helpers client-side. Everything else is locked down:
# no plugins (object-src), no base hijacking (base-uri), restricted form
# targets, and frame-ancestors synced with X-Frame-Options.
CSP_POLICY = (
    "default-src 'self'; "
    "img-src 'self' data: blob: https://images.unsplash.com https://*.unsplash.com; "
    "font-src 'self' https://fonts.gstatic.com data:; "
    "connect-src 'self'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "script-src 'self' 'unsafe-inline'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    + ("" if ALLOW_FRAME_EMBED else "frame-ancestors 'self';")
)

SECURITY_HEADERS = [
    ("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload"),
    ("X-Content-Type-Options", "nosniff"),
] + ([] if ALLOW_FRAME_EMBED else [("X-Frame-Options", "SAMEORIGIN")]) + [
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)"),
    ("Cross-Origin-Opener-Policy", "same-origin-allow-popups"),
    ("Content-Security-Policy", CSP_POLICY),
]

# ============================================================================
# Static file exposure controls
# ============================================================================
# Only these file extensions may ever be served. Server-side source code
# (.py), configs (.yaml, Procfile), lockfiles, docs and dotfiles are NOT
# reachable over HTTP.
ALLOWED_STATIC_EXTENSIONS = {
    ".html", ".css", ".js", ".mjs", ".json", ".svg", ".png", ".jpg", ".jpeg",
    ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".xml",
    ".txt", ".webmanifest", ".apk", ".map",
}

# Top-level directories that must never be exposed over HTTP.
BLOCKED_TOP_DIRS = {
    ".git", ".github", "android", "scripts", "migrations", "components",
    "pos-dist", "node_modules", "__pycache__",
}

# Specific filenames that pass the extension allowlist but are still private.
BLOCKED_FILENAMES = {
    "requirements.txt", "package.json", "package-lock.json",
    "capacitor.config.json", "tsconfig.json",
}

# Request body ceiling for API calls (5 MB covers base64 intake photos).
MAX_API_BODY_BYTES = int(os.environ.get("MAX_API_BODY_BYTES", str(5 * 1024 * 1024)))


def resolve_static_file(clean_path: str) -> str | None:
    """Safely map a URL path to a file inside the web root.

    Defends against path traversal (.., encoded separators, symlink escape)
    and blocks dotfiles, server source code, configs, and private directories.
    Returns an absolute path or None when the request must be refused.
    """
    if clean_path in ROUTES:
        return os.path.join(ROOT, ROUTES[clean_path])

    relative = clean_path.lstrip("/")
    if not relative or "\\" in relative or "\x00" in relative:
        return None

    segments = relative.split("/")
    for segment in segments:
        # Reject traversal and every hidden file/directory (.git, .env, ...)
        if segment in ("", ".", "..") or segment.startswith("."):
            return None

    if segments[0].lower() in BLOCKED_TOP_DIRS:
        return None
    if len(segments) == 1 and segments[0].lower() in BLOCKED_FILENAMES:
        return None

    _, ext = os.path.splitext(segments[-1])
    if ext.lower() not in ALLOWED_STATIC_EXTENSIONS:
        return None

    candidate = os.path.realpath(os.path.join(ROOT, *segments))
    # Containment check: the resolved real path must stay inside the web root.
    if not candidate.startswith(os.path.realpath(ROOT) + os.sep):
        return None
    if not os.path.isfile(candidate):
        return None
    return candidate

# The APK serves its bundled UI from WebViewAssetLoader. Its HTTPS-like
# appassets origin is therefore cross-origin to the live API. Keep this list
# explicit rather than enabling CORS for every website.
MOBILE_APP_ORIGINS = {
    "https://appassets.androidplatform.net",
    "https://localhost",       # Capacitor Android scheme
    "capacitor://localhost",  # Older Capacitor projects
}


def api_cors_headers(origin: str) -> list[tuple[str, str]]:
    """Return CORS headers for the native POS origin, if it is allowed."""
    if origin not in MOBILE_APP_ORIGINS:
        return []
    return [
        ("Access-Control-Allow-Origin", origin),
        ("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Terminal-Key, X-Staff-Token"),
        ("Access-Control-Max-Age", "600"),
        ("Vary", "Origin"),
    ]


def get_cache_headers(filepath: str) -> list[tuple[str, str]]:
    """Generates optimal caching headers for static assets vs dynamic pages."""
    rel = os.path.relpath(filepath, ROOT)
    is_static = (
        rel.startswith("assets/") or
        rel.startswith("css/") or
        rel.startswith("js/") or
        filepath.endswith((".svg", ".png", ".jpg", ".jpeg", ".webp", ".woff2", ".ico"))
    )
    if is_static and not rel.endswith(".html"):
        return [("Cache-Control", "public, max-age=31536000, immutable")]
    return [("Cache-Control", "no-cache, no-store, must-revalidate")]


# ============================================================================
# WSGI Application for Gunicorn / Render Production Workers
# ============================================================================
def wsgi_app(environ, start_response):
    """
    High-performance WSGI handler compatible with Gunicorn on Render.
    Routes /api/* to the database API layer and serves static assets directly.
    """
    method = environ.get("REQUEST_METHOD", "GET").upper()
    raw_path = environ.get("PATH_INFO", "/")
    query_string = environ.get("QUERY_STRING", "")
    query_params = urllib.parse.parse_qs(query_string)

    # 0. Real-time notification stream (SSE) — streamed as a generator so
    #    Gunicorn forwards frames as they are produced.
    if raw_path == "/api/notifications/stream" and method == "GET":
        origin = environ.get("HTTP_ORIGIN", "")
        cors = api_cors_headers(origin)
        ticket = (query_params.get("ticket", [""])[0] or "").strip()
        staff = notifications.redeem_stream_ticket(ticket)
        if not staff:
            payload = b'{"ok": false, "error": "Unauthorized: a valid stream ticket is required"}'
            start_response("401 Unauthorized", [
                ("Content-Type", "application/json; charset=utf-8"),
                ("Content-Length", str(len(payload))), *cors, *SECURITY_HEADERS,
            ])
            return [payload]

        start_response("200 OK", [
            ("Content-Type", "text/event-stream; charset=utf-8"),
            ("Cache-Control", "no-cache, no-store, must-revalidate"),
            ("X-Accel-Buffering", "no"), *cors, *SECURITY_HEADERS,
        ])

        def sse_generator():
            q = notifications.subscribe()
            try:
                yield notifications.sse_preamble()
                while True:
                    yield notifications.next_frame(q, timeout=25.0)
            finally:
                notifications.unsubscribe(q)

        return sse_generator()

    # 1. API Route Handling
    if raw_path.startswith("/api/"):
        origin = environ.get("HTTP_ORIGIN", "")
        cors = api_cors_headers(origin)

        # WebView fetches with Authorization/X-Terminal-Key trigger a CORS
        # preflight. It must be answered before the API router reads a body.
        if method == "OPTIONS":
            headers = [("Content-Length", "0"), *cors, *SECURITY_HEADERS]
            start_response("204 No Content", headers)
            return [b""]

        try:
            content_length = int(environ.get("CONTENT_LENGTH", 0) or 0)
        except (TypeError, ValueError):
            content_length = 0

        # Reject oversized payloads before buffering them.
        if content_length > MAX_API_BODY_BYTES:
            payload = b'{"ok": false, "error": "Request body too large"}'
            headers = [
                ("Content-Type", "application/json; charset=utf-8"),
                ("Content-Length", str(len(payload))),
                *cors, *SECURITY_HEADERS,
            ]
            start_response("413 Payload Too Large", headers)
            return [payload]

        body_bytes = b""
        try:
            if content_length > 0:
                body_bytes = environ["wsgi.input"].read(content_length)
        except Exception:
            body_bytes = b""

        headers_dict = {}
        for k, v in environ.items():
            if k.startswith("HTTP_"):
                header_name = k[5:].replace("_", "-").lower()
                headers_dict[header_name] = v
            elif k in ("CONTENT_TYPE", "CONTENT_LENGTH"):
                headers_dict[k.replace("_", "-").lower()] = v

        status_code, content_type, response_body = handle_api_request(
            method, raw_path, query_params, body_bytes, headers=headers_dict,
            client_addr=environ.get("REMOTE_ADDR", "")
        )

        headers = [
            ("Content-Type", content_type),
            ("Content-Length", str(len(response_body))),
            ("Cache-Control", "no-cache, no-store, must-revalidate")
        ]
        headers.extend(cors)
        headers.extend(SECURITY_HEADERS)

        status_str = f"{status_code} " + ("OK" if status_code == 200 else ("Created" if status_code == 201 else "Error"))
        start_response(status_str, headers)
        if method == "HEAD":
            return [b""]
        return [response_body]

    # 2. Static Clean Route Resolution (traversal-safe, allowlisted)
    clean_path = raw_path.rstrip("/") or "/"
    target_file = resolve_static_file(clean_path)

    # 3. File Serving & Compression
    if target_file and os.path.isfile(target_file):
        mime_type, _ = mimetypes.guess_type(target_file)
        if not mime_type:
            mime_type = "application/octet-stream"

        with open(target_file, "rb") as f:
            content = f.read()

        accept_encoding = environ.get("HTTP_ACCEPT_ENCODING", "")
        should_gzip = "gzip" in accept_encoding and any(mime_type.startswith(t) for t in COMPRESSIBLE_TYPES) and len(content) > 256

        headers = [
            ("Content-Type", f"{mime_type}; charset=utf-8" if "text" in mime_type or "svg" in mime_type or "javascript" in mime_type or "json" in mime_type else mime_type),
        ]
        if target_file.endswith(".apk"):
            headers.append(("Content-Disposition", 'attachment; filename="adonai-pos-v2.apk"'))
        headers.extend(SECURITY_HEADERS)
        headers.extend(get_cache_headers(target_file))

        if should_gzip:
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
                gz.write(content)
            content = buf.getvalue()
            headers.append(("Content-Encoding", "gzip"))
            headers.append(("Vary", "Accept-Encoding"))

        headers.append(("Content-Length", str(len(content))))
        start_response("200 OK", headers)
        if method == "HEAD":
            return [b""]
        return [content]

    # 4. 404 Handler
    error_404_path = os.path.join(ROOT, "404.html")
    content_404 = b"<h1>404 Not Found</h1>"
    if os.path.isfile(error_404_path):
        with open(error_404_path, "rb") as f:
            content_404 = f.read()

    headers = [
        ("Content-Type", "text/html; charset=utf-8"),
        ("Content-Length", str(len(content_404))),
        ("Cache-Control", "no-cache, no-store, must-revalidate")
    ]
    headers.extend(SECURITY_HEADERS)
    start_response("404 Not Found", headers)
    if method == "HEAD":
        return [b""]
    return [content_404]


# Export WSGI application callable
app = wsgi_app


# ============================================================================
# Standalone Multi-Threaded HTTP Server for CLI / Local & Dev
# ============================================================================
class ProductionHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_HEAD(self):
        self.handle_http(head_only=True)

    def do_GET(self):
        self.handle_http(head_only=False)

    def do_POST(self):
        self.handle_http(head_only=False)

    def do_PUT(self):
        self.handle_http(head_only=False)

    def do_DELETE(self):
        self.handle_http(head_only=False)

    def do_OPTIONS(self):
        self.handle_http(head_only=False)

    def handle_http(self, head_only=False):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # 0. Real-time notification stream (long-lived SSE connection).
        #    Handled before the buffered API dispatch: each client holds one
        #    thread of the ThreadingTCPServer and receives events as they fire.
        if path == "/api/notifications/stream" and self.command == "GET" and not head_only:
            self.handle_notification_stream(parsed)
            return

        # 1. API Endpoint Dispatch
        if path.startswith("/api/"):
            origin = self.headers.get("Origin", "")
            cors = api_cors_headers(origin)
            if self.command == "OPTIONS":
                self.send_response(204)
                self.send_header("Content-Length", "0")
                for k, v in [*cors, *SECURITY_HEADERS]:
                    self.send_header(k, v)
                self.end_headers()
                return

            query_params = urllib.parse.parse_qs(parsed.query)
            try:
                content_len = int(self.headers.get("Content-Length", 0) or 0)
            except (TypeError, ValueError):
                content_len = 0

            if content_len > MAX_API_BODY_BYTES:
                payload = b'{"ok": false, "error": "Request body too large"}'
                self.send_response(413)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                for k, v in [*cors, *SECURITY_HEADERS]:
                    self.send_header(k, v)
                self.end_headers()
                if not head_only:
                    self.wfile.write(payload)
                return

            body_bytes = b""
            try:
                if content_len > 0:
                    body_bytes = self.rfile.read(content_len)
            except Exception:
                body_bytes = b""

            headers_dict = {k.lower(): v for k, v in self.headers.items()}
            status_code, content_type, response_body = handle_api_request(
                self.command, path, query_params, body_bytes, headers=headers_dict,
                client_addr=(self.client_address[0] if self.client_address else "")
            )

            self.send_response(status_code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(response_body)))
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            for k, v in [*cors, *SECURITY_HEADERS]:
                self.send_header(k, v)
            self.end_headers()

            if not head_only:
                self.wfile.write(response_body)
            return

        # 2. Clean URL Routing (traversal-safe, allowlisted)
        clean_path = path.rstrip("/") or "/"
        target_file = resolve_static_file(clean_path)

        # 3. Serve File or 404
        if target_file and os.path.isfile(target_file):
            mime_type, _ = mimetypes.guess_type(target_file)
            if not mime_type:
                mime_type = "application/octet-stream"

            with open(target_file, "rb") as f:
                content = f.read()

            accept_encoding = self.headers.get("Accept-Encoding", "")
            should_gzip = "gzip" in accept_encoding and any(mime_type.startswith(t) for t in COMPRESSIBLE_TYPES) and len(content) > 256

            if should_gzip:
                buf = io.BytesIO()
                with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
                    gz.write(content)
                content = buf.getvalue()

            self.send_response(200)
            self.send_header("Content-Type", f"{mime_type}; charset=utf-8" if "text" in mime_type or "svg" in mime_type or "javascript" in mime_type or "json" in mime_type else mime_type)
            self.send_header("Content-Length", str(len(content)))
            if target_file.endswith(".apk"):
                self.send_header("Content-Disposition", 'attachment; filename="adonai-pos-v2.apk"')
            if should_gzip:
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Vary", "Accept-Encoding")

            for k, v in SECURITY_HEADERS:
                self.send_header(k, v)
            for k, v in get_cache_headers(target_file):
                self.send_header(k, v)
            self.end_headers()

            if not head_only:
                self.wfile.write(content)
        else:
            error_file = os.path.join(ROOT, "404.html")
            content_404 = b"<h1>404 Not Found</h1>"
            if os.path.isfile(error_404_path := os.path.join(ROOT, "404.html")):
                with open(error_404_path, "rb") as f:
                    content_404 = f.read()

            self.send_response(404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(content_404)))
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            for k, v in SECURITY_HEADERS:
                self.send_header(k, v)
            self.end_headers()
            if not head_only:
                self.wfile.write(content_404)

    def handle_notification_stream(self, parsed):
        """
        Server-Sent Events endpoint: /api/notifications/stream?ticket=...
        The ticket is a single-use 60s handshake issued by
        POST /api/notifications/ticket to header-authenticated staff —
        long-lived credentials never appear in the URL.
        """
        query = urllib.parse.parse_qs(parsed.query)
        ticket = (query.get("ticket", [""])[0] or "").strip()
        staff = notifications.redeem_stream_ticket(ticket)

        origin = self.headers.get("Origin", "")
        cors = api_cors_headers(origin)

        if not staff:
            payload = b'{"ok": false, "error": "Unauthorized: a valid stream ticket is required"}'
            self.send_response(401)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            for k, v in [*cors, *SECURITY_HEADERS]:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(payload)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        for k, v in [*cors, *SECURITY_HEADERS]:
            self.send_header(k, v)
        self.end_headers()

        q = notifications.subscribe()
        logger.info("SSE notification stream opened for %s (%s)",
                    staff.get("name", "Staff"), self.client_address[0] if self.client_address else "?")
        try:
            self.wfile.write(notifications.sse_preamble())
            self.wfile.flush()
            while True:
                frame = notifications.next_frame(q, timeout=25.0)
                self.wfile.write(frame)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # client navigated away or network dropped — normal lifecycle
        finally:
            notifications.unsubscribe(q)

    def log_message(self, format, *args):
        pass


def run_standalone_server():
    """Initializes database and boots standalone server."""
    # Run auto-migrations on boot
    init_db()

    # Read PORT from Render environment (defaults to 10000 on Render, or 8080 locally)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "10000"))
    socketserver.ThreadingTCPServer.allow_reuse_address = True

    with socketserver.ThreadingTCPServer(("0.0.0.0", port), ProductionHandler) as srv:
        print(f"Adonai Store Server listening on 0.0.0.0:{port}")
        print(f"  Storefront        : http://0.0.0.0:{port}/")
        print(f"  API Health Check  : http://0.0.0.0:{port}/api/health")
        print(f"  POS Terminal      : http://0.0.0.0:{port}/pos")
        print(f"  Admin Console     : http://0.0.0.0:{port}/admin")
        print(f"  Database Mode     : {'Render PostgreSQL' if IS_POSTGRES else 'SQLite Fallback'}")
        srv.serve_forever()


if __name__ == "__main__":
    run_standalone_server()
