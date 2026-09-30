#!/usr/bin/env python3
"""
Adonai Thrift Store — Production Server & WSGI Gateway for Render
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
    "/": "index.html",
    "/store": "index.html",
    "/pos": "pos.html",
    "/admin": "admin.html",
    "/login": "login.html",
    "/privacy-policy": "privacy-policy.html",
    "/terms-and-conditions": "terms-and-conditions.html",
    "/sitemap.xml": "sitemap.xml",
    "/robots.txt": "robots.txt",
    "/manifest.json": "manifest.json",
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


SECURITY_HEADERS = [
    ("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload"),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "SAMEORIGIN"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
    ("Content-Security-Policy",
     "default-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com https://images.unsplash.com https://wa.me; "
     "img-src 'self' data: blob: https://images.unsplash.com https://*.unsplash.com https://wa.me; "
     "font-src 'self' https://fonts.gstatic.com data:; "
     "connect-src 'self'; "
     "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
     "script-src 'self' 'unsafe-inline';")
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

    # 1. API Route Handling
    if raw_path.startswith("/api/"):
        body_bytes = b""
        try:
            content_length = int(environ.get("CONTENT_LENGTH", 0) or 0)
            if content_length > 0:
                body_bytes = environ["wsgi.input"].read(content_length)
        except Exception:
            body_bytes = b""

        status_code, content_type, response_body = handle_api_request(
            method, raw_path, query_params, body_bytes
        )

        headers = [
            ("Content-Type", content_type),
            ("Content-Length", str(len(response_body))),
            ("Cache-Control", "no-cache, no-store, must-revalidate")
        ]
        headers.extend(SECURITY_HEADERS)

        status_str = f"{status_code} " + ("OK" if status_code == 200 else ("Created" if status_code == 201 else "Error"))
        start_response(status_str, headers)
        if method == "HEAD":
            return [b""]
        return [response_body]

    # 2. Static Clean Route Resolution
    clean_path = raw_path.rstrip("/") or "/"
    target_file = None
    if clean_path in ROUTES:
        target_file = os.path.join(ROOT, ROUTES[clean_path])
    else:
        candidate = os.path.join(ROOT, clean_path.lstrip("/"))
        if os.path.isfile(candidate):
            target_file = candidate

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

    def handle_http(self, head_only=False):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # 1. API Endpoint Dispatch
        if path.startswith("/api/"):
            query_params = urllib.parse.parse_qs(parsed.query)
            body_bytes = b""
            try:
                content_len = int(self.headers.get("Content-Length", 0) or 0)
                if content_len > 0:
                    body_bytes = self.rfile.read(content_len)
            except Exception:
                body_bytes = b""

            status_code, content_type, response_body = handle_api_request(
                self.command, path, query_params, body_bytes
            )

            self.send_response(status_code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(response_body)))
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            for k, v in SECURITY_HEADERS:
                self.send_header(k, v)
            self.end_headers()

            if not head_only:
                self.wfile.write(response_body)
            return

        # 2. Clean URL Routing
        clean_path = path.rstrip("/") or "/"
        target_file = None
        if clean_path in ROUTES:
            target_file = os.path.join(ROOT, ROUTES[clean_path])
        else:
            candidate = os.path.join(ROOT, clean_path.lstrip("/"))
            if os.path.isfile(candidate):
                target_file = candidate

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
        print(f"Adonai Thrift Store Server listening on 0.0.0.0:{port}")
        print(f"  Storefront        : http://0.0.0.0:{port}/")
        print(f"  API Health Check  : http://0.0.0.0:{port}/api/health")
        print(f"  POS Terminal      : http://0.0.0.0:{port}/pos")
        print(f"  Admin Console     : http://0.0.0.0:{port}/admin")
        print(f"  Database Mode     : {'Render PostgreSQL' if IS_POSTGRES else 'SQLite Fallback'}")
        srv.serve_forever()


if __name__ == "__main__":
    run_standalone_server()
