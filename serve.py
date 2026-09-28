#!/usr/bin/env python3
"""Adonai Thrift Store — static server with clean routes.

    /            -> public storefront
    /pos         -> cashier terminal
    /admin       -> OPS dashboard
    /login       -> staff login

Usage:  python3 serve.py            (PORT env var optional, default 8080)
"""
import http.server
import os
import socketserver
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
ROUTES = {
    "/": "index.html",
    "/store": "index.html",
    "/pos": "pos.html",
    "/admin": "admin.html",
    "/login": "login.html",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):
        clean = urllib.parse.urlparse(path).path.rstrip("/") or "/"
        if clean in ROUTES:
            path = "/" + ROUTES[clean]
        return super().translate_path(path)

    def end_headers(self):
        # always serve the freshest assets (live multi-tab sync testing)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    PORT = int(os.environ.get("PORT", "8080"))
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), Handler) as srv:
        print(f"Adonai Thrift Store serving:")
        print(f"  storefront : http://localhost:{PORT}/")
        print(f"  POS        : http://localhost:{PORT}/pos")
        print(f"  dashboard  : http://localhost:{PORT}/admin")
        print(f"  login      : http://localhost:{PORT}/login")
        srv.serve_forever()
