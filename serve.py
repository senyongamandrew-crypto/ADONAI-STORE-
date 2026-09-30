#!/usr/bin/env python3
"""Adonai Thrift Store — Production-Hardened Static Server & Gateway
Supports clean route dispatch, gzip compression, HTTP security headers,
cache directives, HTTPS enforcement, and custom 404/500 error pages.

Routes:
    /                     -> public storefront (index.html)
    /pos                  -> cashier POS terminal (pos.html)
    /admin                -> operations dashboard (admin.html)
    /login                -> staff PIN gateway (login.html)
    /privacy-policy       -> legal privacy policy (privacy-policy.html)
    /terms-and-conditions -> store terms & refund policy (terms-and-conditions.html)
    /sitemap.xml          -> search engine sitemap
    /robots.txt           -> crawler directives
    /manifest.json        -> progressive web app manifest
"""
import gzip
import http.server
import io
import mimetypes
import os
import socketserver
import sys
import urllib.parse

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

# Ensure correct MIME type registration
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/manifest+json", ".json")
mimetypes.add_type("application/xml", ".xml")


class ProductionHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_HEAD(self):
        self.handle_request(head_only=True)

    def do_GET(self):
        self.handle_request(head_only=False)

    def handle_request(self, head_only=False):
        # 1. Enforce HTTPS if configured or behind proxy header
        force_https = os.environ.get("FORCE_HTTPS", "false").lower() in ("true", "1")
        proto = self.headers.get("X-Forwarded-Proto", "http")
        host = self.headers.get("Host", "localhost")
        if force_https and proto == "http" and "localhost" not in host and "127.0.0.1" not in host:
            self.send_response(301)
            self.send_header("Location", f"https://{host}{self.path}")
            self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")
            self.end_headers()
            return

        # 2. Route resolution
        parsed = urllib.parse.urlparse(self.path)
        clean_path = parsed.path.rstrip("/") or "/"
        
        target_file = None
        if clean_path in ROUTES:
            target_file = os.path.join(ROOT, ROUTES[clean_path])
        else:
            rel_path = clean_path.lstrip("/")
            candidate = os.path.join(ROOT, rel_path)
            if os.path.isfile(candidate):
                target_file = candidate

        # 3. Serve File or 404
        if target_file and os.path.isfile(target_file):
            try:
                self.serve_file(target_file, clean_path, head_only=head_only)
            except Exception as e:
                self.serve_error(500, str(e), head_only=head_only)
        else:
            self.serve_error(404, "Page Not Found", head_only=head_only)

    def serve_file(self, filepath, clean_path, head_only=False):
        mime_type, _ = mimetypes.guess_type(filepath)
        if not mime_type:
            mime_type = "application/octet-stream"

        with open(filepath, "rb") as f:
            content = f.read()

        # Check if client accepts gzip and content is compressible
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

        self.apply_security_headers()
        self.apply_cache_headers(filepath, clean_path)
        self.end_headers()

        if not head_only:
            self.wfile.write(content)

    def serve_error(self, code, message, head_only=False):
        error_file = os.path.join(ROOT, f"{code}.html")
        if not os.path.isfile(error_file):
            error_file = os.path.join(ROOT, "404.html")

        content = b"Error"
        if os.path.isfile(error_file):
            with open(error_file, "rb") as f:
                content = f.read()

        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.apply_security_headers()
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        if not head_only:
            self.wfile.write(content)

    def apply_security_headers(self):
        self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com https://images.unsplash.com https://wa.me; "
            "img-src 'self' data: blob: https://images.unsplash.com https://*.unsplash.com https://wa.me; "
            "font-src 'self' https://fonts.gstatic.com data:; "
            "connect-src 'self'; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "script-src 'self' 'unsafe-inline';"
        )

    def apply_cache_headers(self, filepath, clean_path):
        rel = os.path.relpath(filepath, ROOT)
        is_static_asset = rel.startswith("assets/") or rel.startswith("css/") or rel.startswith("js/") or filepath.endswith((".svg", ".png", ".jpg", ".woff2", ".ico"))
        
        if is_static_asset and not rel.endswith(".html"):
            # Static assets cache aggressively
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            # HTML pages and dynamic endpoints revalidate
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "8080"))
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), ProductionHandler) as srv:
        print(f"Adonai Thrift Store Production Server listening on 0.0.0.0:{PORT}")
        print(f"  Storefront        : http://localhost:{PORT}/")
        print(f"  POS Terminal      : http://localhost:{PORT}/pos")
        print(f"  Admin Dashboard   : http://localhost:{PORT}/admin")
        print(f"  Privacy Policy    : http://localhost:{PORT}/privacy-policy")
        print(f"  Terms & Return    : http://localhost:{PORT}/terms-and-conditions")
        srv.serve_forever()
