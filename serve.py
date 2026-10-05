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
import json
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
    "/product": "product.html",
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

# ============================================================================
# Product Detail Page (PDP) — /product/<slug> server rendering
# ============================================================================
# The PDP shell is a static file, but every permalink must ship accurate
# <title>, canonical, Open Graph and JSON-LD tags: WhatsApp, Facebook and
# Google only read the raw HTML response, never the hydrated DOM. The block
# between these markers in product.html is swapped for per-product tags.
PDP_HEAD_START = "<!--ADONAI_PDP_HEAD_START-->"
PDP_HEAD_END = "<!--ADONAI_PDP_HEAD_END-->"
PDP_BOOTSTRAP_MARKER = "<!--ADONAI_PDP_BOOTSTRAP-->"
PUBLIC_SITE_URL = os.environ.get("PUBLIC_SITE_URL", "https://adonai-store.onrender.com").rstrip("/")


def html_escape(value: str) -> str:
    return (
        str(value if value is not None else "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def request_origin(environ_or_headers) -> str:
    """Best-effort public origin for canonical/OG URLs (Render, preview, local)."""
    try:
        host = (
            environ_or_headers.get("HTTP_X_FORWARDED_HOST")
            or environ_or_headers.get("HTTP_HOST")
            or ""
        ).split(",")[0].strip()
        scheme = (
            environ_or_headers.get("HTTP_X_FORWARDED_PROTO")
            or environ_or_headers.get("wsgi.url_scheme")
            or "https"
        ).split(",")[0].strip()
    except AttributeError:
        host, scheme = "", "https"
    if not host:
        return PUBLIC_SITE_URL
    return f"{scheme}://{host}"


def absolute_media_url(url: str, origin: str) -> str:
    url = str(url or "").strip()
    if not url or url.startswith("data:"):
        return f"{origin}/assets/og-preview-banner.png"
    if url.startswith(("http://", "https://")):
        return url
    return f"{origin}/{url.lstrip('/')}"


def product_page_html(slug: str, origin: str) -> bytes | None:
    """Render product.html with per-product metadata and bootstrap state.

    Returns None when the PDP shell is missing. A catalog miss still returns
    the shell so the client can show the "piece not found" state (and so a
    cold database never produces a hard 500 on a shared link).
    """
    shell_path = os.path.join(ROOT, "product.html")
    if not os.path.isfile(shell_path):
        return None
    with open(shell_path, "r", encoding="utf-8") as handle:
        html = handle.read()

    product = None
    try:
        from database import get_db
        from api import lookup_product

        with get_db() as session:
            row = lookup_product(session, slug)
            if row:
                product = row.to_dict()
    except Exception as exc:  # pragma: no cover - database optional at render time
        logger.warning("PDP server render fell back to the client shell: %s", exc)

    if not product:
        return html.encode("utf-8")

    price = int(product.get("final_selling_price") or product.get("selling_price") or 0)
    compare = int(product.get("compare_price") or 0)
    in_stock = int(product.get("in_stock_count") or 0) > 0
    canonical = f"{origin}/product/{product.get('slug') or slug}"
    image = absolute_media_url(
        product.get("image_url") or (product.get("images") or [None])[0], origin
    )
    condition = product.get("condition") or "Pre-loved"
    size = product.get("size") or "-"
    title = (
        f"{product.get('name')} — UGX {price:,} | {condition} | Adonai Thrift Store Kampala"
    )
    description = (
        product.get("desc")
        or f"{condition} {product.get('category', 'thrift piece')} from Adonai Thrift Store Kampala."
    )
    description = " ".join(str(description).split())[:180]
    summary = (
        f"{description} Size {size}. UGX {price:,}. "
        "Same-day Kampala delivery, nationwide bus/courier transit, MTN MoMo, Airtel Money or cash."
    )[:300]

    json_ld = {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": product.get("name"),
        "image": [image],
        "description": summary,
        "sku": product.get("sku"),
        "mpn": product.get("barcode_id"),
        "brand": {"@type": "Brand", "name": product.get("brand") or "Vintage / Unbranded"},
        "category": product.get("category"),
        "color": product.get("color") or "",
        "size": size,
        "itemCondition": (
            "https://schema.org/NewCondition"
            if "BNWT" in str(condition).upper()
            else "https://schema.org/UsedCondition"
        ),
        "offers": {
            "@type": "Offer",
            "url": canonical,
            "priceCurrency": "UGX",
            "price": price,
            "availability": (
                "https://schema.org/InStock" if in_stock else "https://schema.org/SoldOut"
            ),
            "itemCondition": (
                "https://schema.org/NewCondition"
                if "BNWT" in str(condition).upper()
                else "https://schema.org/UsedCondition"
            ),
            "seller": {"@type": "Organization", "name": "Adonai Thrift Store"},
            "areaServed": "UG",
        },
    }
    if compare > price > 0:
        json_ld["offers"]["priceSpecification"] = {
            "@type": "PriceSpecification",
            "priceCurrency": "UGX",
            "price": compare,
            "valueAddedTaxIncluded": True,
        }

    # `</` inside an inline <script> must be escaped or the parser ends the tag.
    json_ld_text = json.dumps(json_ld, ensure_ascii=False).replace("</", "<\\/")

    head_block = f"""<title>{html_escape(title)}</title>
<meta name="description" content="{html_escape(summary)}" />
<link rel="canonical" href="{html_escape(canonical)}" />
<meta property="og:type" content="product" />
<meta property="og:site_name" content="Adonai Thrift Store" />
<meta property="og:title" content="{html_escape(product.get('name'))} — UGX {price:,}" />
<meta property="og:description" content="{html_escape(summary)}" />
<meta property="og:url" content="{html_escape(canonical)}" />
<meta property="og:image" content="{html_escape(image)}" />
<meta property="og:image:alt" content="{html_escape(product.get('name'))}" />
<meta property="og:locale" content="en_UG" />
<meta property="product:price:amount" content="{price}" />
<meta property="product:price:currency" content="UGX" />
<meta property="product:availability" content="{'in stock' if in_stock else 'out of stock'}" />
<meta property="product:condition" content="{'new' if 'BNWT' in str(condition).upper() else 'used'}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="{html_escape(product.get('name'))} — UGX {price:,}" />
<meta name="twitter:description" content="{html_escape(summary)}" />
<meta name="twitter:image" content="{html_escape(image)}" />
<script type="application/ld+json">{json_ld_text}</script>"""

    start = html.find(PDP_HEAD_START)
    end = html.find(PDP_HEAD_END)
    if start != -1 and end != -1:
        html = html[:start] + head_block + html[end + len(PDP_HEAD_END):]

    bootstrap = (
        "<script>window.__ADONAI_PDP_PRODUCT__ = "
        + json.dumps(product, ensure_ascii=False).replace("</", "<\\/")
        + ";</script>"
    )
    html = html.replace(PDP_BOOTSTRAP_MARKER, bootstrap)
    return html.encode("utf-8")


def product_slug_from_path(clean_path: str) -> str | None:
    """Return the slug for /product/<slug> requests (None for anything else)."""
    if not clean_path.startswith("/product/"):
        return None
    remainder = clean_path[len("/product/"):]
    if not remainder or "/" in remainder:
        return None
    slug = urllib.parse.unquote(remainder).strip()
    if not slug or len(slug) > 200 or "\x00" in slug:
        return None
    return slug


def build_sitemap(origin: str) -> bytes:
    """Sitemap including every in-stock /product/<slug> permalink."""
    static_paths = ["/", "/store", "/privacy-policy", "/terms-and-conditions"]
    entries = [
        f"  <url><loc>{html_escape(origin + path)}</loc><changefreq>daily</changefreq>"
        f"<priority>{'1.0' if path == '/' else '0.5'}</priority></url>"
        for path in static_paths
    ]
    try:
        from database import get_db
        from models import Product

        with get_db() as session:
            rows = (
                session.query(Product)
                .filter(Product.in_stock_count > 0)
                .filter(Product.inventory_status.notin_(["ARCHIVED", "WRITTEN_OFF"]))
                .order_by(Product.created_at.desc())
                .limit(5000)
                .all()
            )
            for row in rows:
                updated = (row.updated_at or row.created_at)
                lastmod = f"<lastmod>{updated.date().isoformat()}</lastmod>" if updated else ""
                entries.append(
                    f"  <url><loc>{html_escape(origin)}/product/{html_escape(row.public_slug)}</loc>"
                    f"{lastmod}<changefreq>daily</changefreq><priority>0.8</priority></url>"
                )
    except Exception as exc:  # pragma: no cover - static fallback below
        logger.warning("Dynamic sitemap fell back to static entries: %s", exc)

    body = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(entries)
        + "\n</urlset>\n"
    )
    return body.encode("utf-8")


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

    # 2a. Product Detail Page permalinks: /product/<slug>
    slug = product_slug_from_path(clean_path)
    if slug is not None and method in ("GET", "HEAD"):
        rendered = product_page_html(slug, request_origin(environ))
        if rendered is not None:
            headers = [
                ("Content-Type", "text/html; charset=utf-8"),
                ("Cache-Control", "no-cache, no-store, must-revalidate"),
            ]
            headers.extend(SECURITY_HEADERS)
            if "gzip" in environ.get("HTTP_ACCEPT_ENCODING", "") and len(rendered) > 256:
                buf = io.BytesIO()
                with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
                    gz.write(rendered)
                rendered = buf.getvalue()
                headers.append(("Content-Encoding", "gzip"))
                headers.append(("Vary", "Accept-Encoding"))
            headers.append(("Content-Length", str(len(rendered))))
            start_response("200 OK", headers)
            return [b""] if method == "HEAD" else [rendered]

    # 2b. Catalog-aware sitemap (falls back to the static file on DB errors)
    if clean_path == "/sitemap.xml" and method in ("GET", "HEAD"):
        sitemap = build_sitemap(request_origin(environ))
        headers = [
            ("Content-Type", "application/xml; charset=utf-8"),
            ("Cache-Control", "public, max-age=3600"),
            ("Content-Length", str(len(sitemap))),
        ]
        headers.extend(SECURITY_HEADERS)
        start_response("200 OK", headers)
        return [b""] if method == "HEAD" else [sitemap]

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

        # 2a. Product Detail Page permalinks: /product/<slug>
        slug = product_slug_from_path(clean_path)
        if slug is not None and self.command in ("GET", "HEAD"):
            host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or ""
            scheme = self.headers.get("X-Forwarded-Proto") or "http"
            origin = f"{scheme}://{host}" if host else PUBLIC_SITE_URL
            rendered = product_page_html(slug, origin)
            if rendered is not None:
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(rendered)))
                self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
                for k, v in SECURITY_HEADERS:
                    self.send_header(k, v)
                self.end_headers()
                if not head_only:
                    self.wfile.write(rendered)
                return

        # 2b. Catalog-aware sitemap
        if clean_path == "/sitemap.xml" and self.command in ("GET", "HEAD"):
            host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or ""
            scheme = self.headers.get("X-Forwarded-Proto") or "http"
            sitemap = build_sitemap(f"{scheme}://{host}" if host else PUBLIC_SITE_URL)
            self.send_response(200)
            self.send_header("Content-Type", "application/xml; charset=utf-8")
            self.send_header("Content-Length", str(len(sitemap)))
            self.send_header("Cache-Control", "public, max-age=3600")
            for k, v in SECURITY_HEADERS:
                self.send_header(k, v)
            self.end_headers()
            if not head_only:
                self.wfile.write(sitemap)
            return

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
