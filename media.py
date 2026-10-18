"""Managed garment photos and short videos, durable in PostgreSQL / SQLite.

No uploaded bytes are put in catalog JSON or localStorage. Temporary drafts are
private, attachment is part of the product transaction, and ranged video reads
select only the requested byte slice. No ephemeral Render filesystem dependency.
"""
from datetime import datetime, timedelta
from collections import OrderedDict
import io
import json
import os
import re
import struct
import subprocess
import tempfile
import threading
import urllib.parse
import uuid
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

register_heif_opener()

import access_control
from database import get_db
from models import Product, ProductMedia, ProductMediaDerivative, StorePromotionCreative, StoreSetting

MAX_IMAGES = 12
MAX_IMAGE_UPLOAD = 10 * 1024 * 1024
MAX_VIDEO_UPLOAD = 50 * 1024 * 1024
MAX_PROMO_HTML_UPLOAD = 2 * 1024 * 1024
MAX_VIDEO_SECONDS = 30
MAX_STORED_VIDEO = 12 * 1024 * 1024
# Responsive widths the media API can re-encode a stored photo to. The
# storefront asks for one of these with ?w=<px> so a rail card never has to
# download the full-resolution master. 480 exists for the two-column phone
# rail at device-pixel-ratio 2: without it those phones jumped straight
# from 320 to 640 and downloaded roughly double the pixels they show.
MEDIA_WIDTHS = (96, 320, 480, 640, 960)
DERIVATIVE_QUALITY = 72
DERIVATIVE_CACHE_LIMIT = 512
# The per-worker derivative cache is an L1 in front of the durable copies in
# product_media_derivatives. It is budgeted by bytes as well as entries so a
# worker on the small production instance cannot grow it without bound.
DERIVATIVE_CACHE_MAX_BYTES = 24 * 1024 * 1024
MEDIA_ID = re.compile(r"^[0-9a-f]{32}$")
MEDIA_PATH = re.compile(r"^/api/media/([0-9a-f]{32})$")
PROMO_HTML_UPLOAD_PATH = "/api/promo-media/html"
PROMO_HTML_PATH = re.compile(r"^/api/promo-media/([0-9a-f]{32})$")
# Uploaded HTML runs only in a sandboxed iframe (no same-origin, top navigation,
# popups or forms). This CSP permits normal HTTPS-hosted banner assets while
# keeping the creative isolated from the store application and its credentials.
PROMO_HTML_CSP = (
    "sandbox allow-scripts; default-src 'none'; "
    "img-src https: data: blob:; style-src 'unsafe-inline' https: data:; "
    "script-src 'unsafe-inline' https:; font-src https: data:; "
    "connect-src https:; media-src https: data: blob:; frame-src https:; "
    "object-src 'none'; base-uri 'none'; form-action 'none'; "
    "frame-ancestors 'self' https://appassets.androidplatform.net https://localhost capacitor://localhost"
)


class MediaResponse(tuple):
    """Backwards-compatible three-part API response with optional HTTP headers."""
    def __new__(cls, status, content_type, body, headers=None):
        result = super().__new__(cls, (status, content_type, body))
        result.headers = headers or {}
        return result


def error(message, status=400, headers=None):
    return MediaResponse(status, "application/json; charset=utf-8",
                         json.dumps({"ok": False, "error": message}).encode(), headers)


def header(headers, name, default=""):
    return next((str(v) for k, v in (headers or {}).items() if k.lower() == name.lower()), default)


def upload_limit(path):
    clean_path = path.rstrip("/")
    if clean_path == "/api/media/videos":
        return MAX_VIDEO_UPLOAD
    if clean_path == "/api/media/images":
        return MAX_IMAGE_UPLOAD
    if clean_path == PROMO_HTML_UPLOAD_PATH:
        return MAX_PROMO_HTML_UPLOAD
    return None


def _prepare_image(data):
    """Decode and normalize an uploaded photo exactly once.

    Returns (master_jpeg, width, height, derivatives), where derivatives
    maps width -> (webp_bytes, mime) for every responsive width smaller
    than the master. The derivatives are built here — while the photo is
    already decoded for validation — and stored next to the master by the
    upload route, so no shopper request ever waits for an encode: card
    photos are served as plain database reads from the very first view.
    """
    if not data or len(data) > MAX_IMAGE_UPLOAD:
        raise ValueError("Choose an image smaller than 10 MB.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as original:
                if original.format not in {"JPEG", "PNG", "WEBP", "HEIF"}:
                    raise ValueError("Choose a JPG, PNG, WebP or HEIC/HEIF photo.")
                if original.width * original.height > 30_000_000:
                    raise ValueError("This image is too large. Export a smaller phone photo.")
                image = ImageOps.exif_transpose(original).convert("RGB")
                image.thumbnail((1200, 1200))
                output = io.BytesIO()
                # Progressive JPEG: a full-size view paints a soft preview
                # first and sharpens as the bytes arrive, instead of staying
                # blank until the final byte lands on a slow connection.
                image.save(output, "JPEG", quality=82, optimize=True, progressive=True)
                derivatives = {}
                for width in MEDIA_WIDTHS:
                    encoded = _encode_webp_at_width(image, width)
                    if encoded is not None:
                        derivatives[width] = (encoded, "image/webp")
                return output.getvalue(), image.width, image.height, derivatives
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("The photo could not be read. Export it as JPG or PNG and try again.") from exc


def prepare_image(data):
    master, width, height, _derivatives = _prepare_image(data)
    return master, width, height


# ---------------------------------------------------------------------------
# RESPONSIVE DERIVATIVES
#
# A garment photo uploaded through the POS is stored once, full size. Serving
# that master to every rail card meant a shopper downloaded the whole file
# just to see a 280px thumbnail, so the media API also keeps small WebP
# re-encodes at the widths in MEDIA_WIDTHS and hands one back for ?w=<px>.
#
# Those re-encodes used to be built on demand and cached only in worker
# memory. On the small production instance the first shoppers after every
# restart or deploy triggered dozens of simultaneous Pillow encodes through
# a handful of threads, and rail cards sat blank while they queued. The
# derivatives are therefore DURABLE now: they are generated at upload (while
# the photo is already decoded) and stored in product_media_derivatives,
# shared by every worker and surviving restarts. A photo uploaded before
# this change fills its ladder once, on its first sized request. The
# originals stay the source of truth; derivatives are pure cache and can
# always be rebuilt from the master.
# ---------------------------------------------------------------------------
_DERIVATIVE_CACHE: "OrderedDict[str, tuple]" = OrderedDict()
_DERIVATIVE_CACHE_BYTES = 0
_DERIVATIVE_LOCK = threading.Lock()

# Building a derivative is the only expensive step left in a media read,
# and it now happens at most once per photo, ever. These striped locks make
# concurrent first requests for the same legacy photo share that one build
# instead of every worker thread encoding the same image at once.
_DERIVATIVE_BUILD_LOCKS = tuple(threading.Lock() for _ in range(64))


def _derivative_build_lock(source_id):
    return _DERIVATIVE_BUILD_LOCKS[hash(source_id) % len(_DERIVATIVE_BUILD_LOCKS)]


def requested_width(query_params):
    """The ?w= width a caller asked for, snapped to a supported size."""
    if not query_params:
        return None
    raw = query_params.get("w", [None])[0] if hasattr(query_params, "get") else None
    if raw in (None, ""):
        return None
    try:
        width = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    if width <= 0:
        return None
    # Snap to the nearest supported width so a caller can never force an
    # unbounded set of cache entries.
    return min(MEDIA_WIDTHS, key=lambda candidate: (abs(candidate - width), candidate))


def _cache_derivative(key, value):
    global _DERIVATIVE_CACHE_BYTES
    with _DERIVATIVE_LOCK:
        previous = _DERIVATIVE_CACHE.pop(key, None)
        if previous is not None:
            _DERIVATIVE_CACHE_BYTES -= len(previous[0])
        _DERIVATIVE_CACHE[key] = value
        _DERIVATIVE_CACHE_BYTES += len(value[0])
        while _DERIVATIVE_CACHE and (len(_DERIVATIVE_CACHE) > DERIVATIVE_CACHE_LIMIT
                                     or _DERIVATIVE_CACHE_BYTES > DERIVATIVE_CACHE_MAX_BYTES):
            _oldest_key, oldest = _DERIVATIVE_CACHE.popitem(last=False)
            _DERIVATIVE_CACHE_BYTES -= len(oldest[0])


def _read_derivative(key):
    with _DERIVATIVE_LOCK:
        value = _DERIVATIVE_CACHE.get(key)
        if value is not None:
            _DERIVATIVE_CACHE.move_to_end(key)
        return value


def _encode_webp_at_width(image, width):
    """WebP-encode an already-decoded RGB photo at a target width.

    Returns the encoded bytes, or None when the photo is already that
    small — a derivative must never upscale the master.
    """
    if image.width <= width:
        return None
    scale = width / float(image.width)
    size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    resized = image.resize(size, Image.LANCZOS)
    output = io.BytesIO()
    resized.save(output, "WEBP", quality=DERIVATIVE_QUALITY, method=4)
    return output.getvalue()


def _decode_photo(source_bytes):
    """Decode stored photo bytes to a detached RGB image, or None."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(source_bytes)) as original:
                if original.format not in {"JPEG", "PNG", "WEBP", "HEIF"}:
                    return None
                image = ImageOps.exif_transpose(original)
                if image.mode == "RGBA":
                    # A transparent photo would turn black where the alpha was
                    # dropped, so it is laid over white first.
                    background = Image.new("RGB", image.size, (255, 255, 255))
                    background.paste(image, mask=image.split()[3])
                    image = background
                elif image.mode != "RGB":
                    image = image.convert("RGB")
                return image.copy()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        return None


def build_derivative(source_bytes, width):
    """Re-encode a stored photo to a small WebP. Returns (bytes, mime) or None."""
    if not source_bytes or width <= 0:
        return None
    image = _decode_photo(source_bytes)
    if image is None:
        return None
    encoded = _encode_webp_at_width(image, width)
    return (encoded, "image/webp") if encoded is not None else None


def build_derivatives(source_bytes, widths=MEDIA_WIDTHS):
    """Re-encode a stored photo at several widths with a single decode.

    Returns {width: (bytes, mime)} for every requested width below the
    master's own width.
    """
    if not source_bytes:
        return {}
    image = _decode_photo(source_bytes)
    if image is None:
        return {}
    derivatives = {}
    for width in widths:
        encoded = _encode_webp_at_width(image, width)
        if encoded is not None:
            derivatives[width] = (encoded, "image/webp")
    return derivatives


def _stored_derivative(session, source_id, width):
    """The durable derivative bytes for one photo + width, or None."""
    row = (session.query(ProductMediaDerivative.data, ProductMediaDerivative.mime_type)
           .filter_by(source_id=source_id, width=width).first())
    if row is None or row[0] is None:
        return None
    return bytes(row[0]), row[1] or "image/webp"


def _stored_derivative_exists(session, source_id, width):
    """Whether a durable derivative exists — metadata only, no blob read."""
    return (session.query(ProductMediaDerivative.byte_length)
            .filter_by(source_id=source_id, width=width).first() is not None)


def _store_derivatives(session, source_id, derivatives):
    """Persist freshly built derivatives next to their master.

    Best-effort cache: if another worker stored the same width first, the
    unique (source, width) constraint keeps that copy and this insert is
    skipped — never an error for the request that built its own.
    """
    for width, (body, mime) in derivatives.items():
        try:
            with session.begin_nested():
                session.add(ProductMediaDerivative(
                    source_id=source_id, width=width, mime_type=mime,
                    byte_length=len(body), data=body))
                session.flush()
        except IntegrityError:
            continue


def _resolve_derivative(session, asset, width):
    """The derivative for one photo + width, building it at most once ever.

    Order: this worker's memory, then the durable shared copy, then a
    single-flight build from the master (a legacy photo uploaded before
    derivatives were stored at upload). Returns (body, mime), or None when
    the master itself should be served.
    """
    key = f"{asset.id}:{width}"
    cached = _read_derivative(key)
    if cached is not None:
        return cached
    stored = _stored_derivative(session, asset.id, width)
    if stored is not None:
        _cache_derivative(key, stored)
        return stored
    with _derivative_build_lock(asset.id):
        # A sibling thread may have built and stored it while this one
        # waited for the lock — look again before paying for an encode.
        cached = _read_derivative(key)
        if cached is not None:
            return cached
        stored = _stored_derivative(session, asset.id, width)
        if stored is not None:
            _cache_derivative(key, stored)
            return stored
        master = session.query(ProductMedia.data).filter_by(id=asset.id).scalar()
        # Only the asked-for width is built on a shopper's request: encoding
        # the whole ladder here would make this one shopper wait for five
        # encodes. Each remaining width is built (and stored) on its own
        # first request; uploads still pre-build the full ladder.
        built = build_derivatives(bytes(master or b""), widths=(width,))
        if not built:
            return None
        _store_derivatives(session, asset.id, built)
        for built_width, value in built.items():
            _cache_derivative(f"{asset.id}:{built_width}", value)
        return built.get(width)


def promotion_html_dimensions(source, filename):
    """Read common ad dimensions, falling back to the standard 728x90 banner."""
    match = re.search(r"(?<!\d)(\d{2,4})\s*[x×]\s*(\d{2,4})(?!\d)", filename, re.I)
    if match:
        width, height = int(match.group(1)), int(match.group(2))
        if 40 <= width <= 2000 and 20 <= height <= 1200:
            return width, height

    for tag in re.findall(r"(?is)<meta\b[^>]*>", source[:100_000]):
        name = re.search(r"\bname\s*=\s*(['\"])(.*?)\1", tag, re.I)
        content = re.search(r"\bcontent\s*=\s*(['\"])(.*?)\1", tag, re.I)
        if name and content and name.group(2).strip().lower() == "ad.size":
            match = re.search(r"width\s*=\s*(\d{2,4})\s*[,;]\s*height\s*=\s*(\d{2,4})", content.group(2), re.I)
            if match:
                width, height = int(match.group(1)), int(match.group(2))
                if 40 <= width <= 2000 and 20 <= height <= 1200:
                    return width, height

    # Also recognize fixed-size CSS / HTML dimensions on the same element.
    dimension = re.search(
        r"(?:width\s*[:=]\s*['\"]?(\d{2,4})\s*(?:px)?['\"]?[^>]{0,120}"
        r"height\s*[:=]\s*['\"]?(\d{2,4})\s*(?:px)?['\"]?|"
        r"height\s*[:=]\s*['\"]?(\d{2,4})\s*(?:px)?['\"]?[^>]{0,120}"
        r"width\s*[:=]\s*['\"]?(\d{2,4})\s*(?:px)?['\"]?)",
        source[:100_000], re.I,
    )
    if dimension:
        groups = dimension.groups()
        width, height = (int(groups[0]), int(groups[1])) if groups[0] else (int(groups[3]), int(groups[2]))
        if 40 <= width <= 2000 and 20 <= height <= 1200:
            return width, height
    return 728, 90


def prepare_promotion_html(data, filename):
    """Bound and validate a single UTF-8 HTML banner before durable storage."""
    if not data or len(data) > MAX_PROMO_HTML_UPLOAD:
        raise ValueError("Choose an HTML banner smaller than 2 MB.")
    if os.path.splitext(filename)[1].lower() not in {".html", ".htm"}:
        raise ValueError("Choose an .html or .htm banner file.")
    try:
        source = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("The HTML banner must be saved as UTF-8.") from exc
    if "\x00" in source or not re.search(r"<[a-zA-Z!][^>]*>", source):
        raise ValueError("This file does not contain readable HTML markup.")
    width, height = promotion_html_dimensions(source, filename)
    return data, width, height


def boxes(data, start=0, end=None):
    """Bounded ISO BMFF box iterator; rejects malformed sizes / truncated uploads."""
    end = len(data) if end is None else end
    offset = start
    count = 0
    while offset < end:
        count += 1
        if count > 10000:
            raise ValueError("Unsupported video metadata.")
        if end - offset < 8:
            raise ValueError("This video file is incomplete.")
        length, kind = struct.unpack_from(">I4s", data, offset)
        header_size = 8
        if length == 1:
            if end - offset < 16:
                raise ValueError("This video file is incomplete.")
            length = struct.unpack_from(">Q", data, offset + 8)[0]
            header_size = 16
        elif length == 0:
            length = end - offset
        if length < header_size or offset + length > end:
            raise ValueError("This video file is incomplete.")
        yield kind, offset + header_size, offset + length
        offset += length


def mp4_info(data):
    if len(data) < 24:
        raise ValueError("Choose an MP4 or MOV video from your phone.")
    roots = list(boxes(data))
    if not any(kind == b"ftyp" for kind, _, _ in roots):
        raise ValueError("Choose an MP4 or MOV video; other formats are not supported.")
    movie = next(((a, b) for kind, a, b in roots if kind == b"moov"), None)
    if not movie:
        raise ValueError("The video metadata is missing. Export it as an MP4 and try again.")
    duration = None
    video = False
    width = height = 0
    containers = {b"moov", b"trak", b"mdia", b"minf", b"dinf"}
    count = 0

    def visit(start, end, depth=0):
        nonlocal duration, video, width, height, count
        if depth > 8:
            raise ValueError("Unsupported video metadata.")
        for kind, a, b in boxes(data, start, end):
            count += 1
            if count > 10000:
                raise ValueError("Unsupported video metadata.")
            if kind == b"mvhd":
                if b - a < 20:
                    raise ValueError("Invalid video duration.")
                if data[a] == 0:
                    timescale, length = struct.unpack_from(">II", data, a + 12)
                elif data[a] == 1 and b - a >= 32:
                    timescale = struct.unpack_from(">I", data, a + 20)[0]
                    length = struct.unpack_from(">Q", data, a + 24)[0]
                else:
                    raise ValueError("Unsupported video duration metadata.")
                if timescale:
                    duration = length / timescale
            elif kind == b"hdlr" and b - a >= 12:
                video = video or data[a + 8:a + 12] == b"vide"
            elif kind == b"tkhd" and b - a >= 8:
                w, h = struct.unpack_from(">II", data, b - 8)
                width, height = max(width, w // 65536), max(height, h // 65536)
            elif kind == b"dref":
                if b - a < 8:
                    raise ValueError("Invalid video references.")
                for ref, c, d in boxes(data, a + 8, b):
                    # Never let an uploaded MOV reference local files / URLs.
                    if ref not in {b"url ", b"urn "} or d - c < 4 or not (int.from_bytes(data[c:c + 4], "big") & 1):
                        raise ValueError("This video contains external references. Export a self-contained MP4.")
            elif kind in containers:
                visit(a, b, depth + 1)

    visit(*movie)
    if not video or duration is None or not 0 < duration <= MAX_VIDEO_SECONDS + 0.5:
        raise ValueError("Choose a video up to 30 seconds long. Trim longer clips on your phone first.")
    if not width or not height or width > 4096 or height > 4096:
        raise ValueError("Choose an HD video, not an oversized 4K / 8K recording.")
    return min(duration, MAX_VIDEO_SECONDS), width, height


def prepare_video(data):
    if not data or len(data) > MAX_VIDEO_UPLOAD:
        raise ValueError("Choose an MP4 / MOV video smaller than 50 MB.")
    mp4_info(data)  # Validate duration, dimensions and self-contained references first.
    try:
        import imageio_ffmpeg
        executable = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:
        raise RuntimeError("Video processing is unavailable. Install the media dependencies on the server.") from exc
    with tempfile.TemporaryDirectory(prefix="adonai-clip-") as directory:
        source = os.path.join(directory, "input.mp4")
        output = os.path.join(directory, "garment.mp4")
        with open(source, "wb") as file:
            file.write(data)
        command = [executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
                   "-max_alloc", "67108864", "-max_pixels", "16777216", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", source,
                   "-map", "0:v:0", "-map", "0:a:0?", "-t", "30",
                   "-vf", "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
                   "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-threads", "1",
                   "-maxrate", "2M", "-bufsize", "4M", "-pix_fmt", "yuv420p",
                   "-c:a", "aac", "-b:a", "96k", "-map_metadata", "-1", "-movflags", "+faststart", "-y", output]
        try:
            result = subprocess.run(command, capture_output=True, timeout=90, check=False)
        except (subprocess.TimeoutExpired, OSError) as exc:
            raise ValueError("Video processing timed out. Export a smaller 720p MP4 and try again.") from exc
        if result.returncode != 0 or not os.path.isfile(output):
            raise ValueError("This video could not be processed. Export a standard MP4 from your phone and try again.")
        if os.path.getsize(output) > MAX_STORED_VIDEO:
            raise ValueError("The optimized clip is still too large. Use a shorter / lower-resolution recording.")
        with open(output, "rb") as file:
            normalized = file.read()
        duration, width, height = mp4_info(normalized)
        return normalized, duration, width, height


def published_promo_media_ids(session):
    """Return only durable image assets explicitly published in the public promo strip."""
    setting = session.query(StoreSetting).filter_by(key="storefront_promo_ids").first()
    if not setting:
        return set()
    try:
        config = json.loads(setting.value or "")
    except (TypeError, ValueError):
        return set()
    if not isinstance(config, dict) or config.get("mode") != "custom" or not isinstance(config.get("items"), list):
        return set()
    return {
        item.get("media_id") for item in config["items"]
        if isinstance(item, dict) and str(item.get("type") or "image").lower() == "image"
        and isinstance(item.get("media_id"), str) and MEDIA_ID.fullmatch(item["media_id"])
    }


def published_promo_html_ids(session):
    """Return HTML creative IDs explicitly published in the shared store setting."""
    setting = session.query(StoreSetting).filter_by(key="storefront_promo_ids").first()
    if not setting:
        return set()
    try:
        config = json.loads(setting.value or "")
    except (TypeError, ValueError):
        return set()
    if not isinstance(config, dict) or config.get("mode") != "custom" or not isinstance(config.get("items"), list):
        return set()
    return {
        item.get("media_id") for item in config["items"]
        if isinstance(item, dict) and item.get("type") == "html"
        and isinstance(item.get("media_id"), str) and MEDIA_ID.fullmatch(item["media_id"])
    }


def sanitize_filename(headers, fallback):
    filename = urllib.parse.unquote(header(headers, "X-File-Name", fallback))
    filename = os.path.basename(filename.replace("\\", "/"))[:150]
    return re.sub(r"[\x00-\x1f\x7f]", "", filename) or fallback


def route_promotion_html_request(method, headers, staff, promo_match):
    with get_db() as session:
        asset = session.query(StorePromotionCreative).filter_by(id=promo_match.group(1)).first()
        if not asset:
            return error("Media not found", 404)
        published_ids = published_promo_html_ids(session)
        if method == "DELETE":
            if asset.id in published_ids:
                return error("Remove this HTML banner from the published storefront promotions first.", 409)
            if not staff or not access_control.allowed("stock", access_control.state(headers, session)):
                return error("Media not found", 404)
            if asset.uploaded_by != str(staff.get("id")) and staff.get("role") not in {"admin", "manager"}:
                return error("Media not found", 404)
            session.delete(asset)
            return MediaResponse(200, "application/json; charset=utf-8", b'{"ok": true}')
        if method not in {"GET", "HEAD"}:
            return error("Method not allowed", 405)

        public = asset.id in published_ids
        if not public and (not staff or not access_control.allowed("stock", access_control.state(headers, session))):
            return error("Media not found", 404)
        if not public and asset.uploaded_by != str((staff or {}).get("id")) and (staff or {}).get("role") not in {"admin", "manager"}:
            return error("Media not found", 404)

        etag = '"' + asset.id + '"'
        extra = {
            "Cache-Control": "public, max-age=86400" if public else "private, no-store",
            "ETag": etag,
            "Content-Security-Policy": PROMO_HTML_CSP,
            "Content-Length": str(asset.byte_length),
        }
        if public and header(headers, "If-None-Match") == etag:
            return MediaResponse(304, "text/html; charset=utf-8", b"", extra)
        payload = b"" if method == "HEAD" else session.query(
            func.substr(StorePromotionCreative.data, 1, asset.byte_length)
        ).filter_by(id=asset.id).scalar()
        return MediaResponse(200, "text/html; charset=utf-8", bytes(payload or b""), extra)


def route_request(method, path, data, headers, staff, query_params=None):
    """Called after existing staff + optional stock-area authorization."""
    if path == PROMO_HTML_UPLOAD_PATH and method == "POST":
        filename = sanitize_filename(headers, "promotion.html")
        try:
            prepared, width, height = prepare_promotion_html(data, filename)
        except ValueError as exc:
            return error(str(exc))
        filename = filename[:150]
        with get_db() as session:
            stale_drafts = session.query(StorePromotionCreative).filter(
                StorePromotionCreative.created_at < datetime.utcnow() - timedelta(days=1),
            )
            published_ids = published_promo_html_ids(session)
            if published_ids:
                stale_drafts = stale_drafts.filter(~StorePromotionCreative.id.in_(published_ids))
            stale_drafts.delete(synchronize_session=False)
            asset = StorePromotionCreative(
                id=uuid.uuid4().hex, mime_type="text/html", filename=filename,
                byte_length=len(prepared), width=width, height=height, data=prepared,
                uploaded_by=str((staff or {}).get("id", "OPEN-TERMINAL")),
            )
            session.add(asset)
            session.flush()
            return MediaResponse(201, "application/json; charset=utf-8",
                                 json.dumps({"ok": True, "creative": asset.to_dict()}).encode())

    if path in {"/api/media/images", "/api/media/videos"} and method == "POST":
        derivatives = {}
        try:
            if path.endswith("images"):
                prepared, width, height, derivatives = _prepare_image(data)
                kind, mime, duration, extension = "image", "image/jpeg", None, ".jpg"
            else:
                prepared, duration, width, height = prepare_video(data)
                kind, mime, extension = "video", "video/mp4", ".mp4"
        except ValueError as exc:
            return error(str(exc))
        except RuntimeError as exc:
            return error(str(exc), 503)
        filename = urllib.parse.unquote(header(headers, "X-File-Name", "garment"))
        filename = os.path.basename(filename.replace("\\", "/"))[:150]
        filename = re.sub(r"[\x00-\x1f\x7f]", "", filename) or "garment"
        filename = os.path.splitext(filename)[0] + extension
        with get_db() as session:
            # Unpublished unattached drafts expire after a day; published strip
            # images remain durable until the owner removes them from settings.
            stale_drafts = session.query(ProductMedia).filter(
                ProductMedia.product_id.is_(None),
                ProductMedia.created_at < datetime.utcnow() - timedelta(days=1),
            )
            published_ids = published_promo_media_ids(session)
            if published_ids:
                stale_drafts = stale_drafts.filter(~ProductMedia.id.in_(published_ids))
            stale_drafts.delete(synchronize_session=False)
            asset = ProductMedia(id=uuid.uuid4().hex, kind=kind, mime_type=mime,
                filename=filename, byte_length=len(prepared), width=width, height=height,
                duration=duration, data=prepared, uploaded_by=str(staff.get("id", "OPEN-TERMINAL")))
            session.add(asset); session.flush()
            if kind == "image" and derivatives:
                # The responsive copies are stored with the master, in the
                # same transaction, so the very first shopper is answered
                # with a database read — never an on-the-fly encode.
                _store_derivatives(session, asset.id, derivatives)
            return MediaResponse(201, "application/json; charset=utf-8", json.dumps({"ok": True, "media": asset.to_dict()}).encode())
    promo_match = PROMO_HTML_PATH.fullmatch(path)
    if promo_match:
        return route_promotion_html_request(method, headers, staff, promo_match)
    match = MEDIA_PATH.fullmatch(path)
    if not match:
        return error("Media route not found", 404)
    with get_db() as session:
        query = session.query(ProductMedia).filter_by(id=match.group(1))
        asset = (query.with_for_update() if method == "DELETE" else query).first()
        if not asset:
            return error("Media not found", 404)
        promo_media_ids = published_promo_media_ids(session)
        if method == "DELETE":
            if asset.product_id:
                return error("Save the garment without this media to remove it.", 409)
            if asset.id in promo_media_ids:
                return error("Remove this image from the published storefront promotions first.", 409)
            if asset.uploaded_by != str(staff.get("id")) and staff.get("role") not in {"admin", "manager"}:
                return error("Media not found", 404)
            session.delete(asset)
            return MediaResponse(200, "application/json; charset=utf-8", b'{"ok": true}')
        public = bool(asset.product_id and asset.product and asset.product.inventory_status not in {"ARCHIVED", "WRITTEN_OFF"})
        if asset.kind == "image" and asset.product_id is None and asset.id in promo_media_ids:
            public = True
        if not public and (not staff or not access_control.allowed("stock", access_control.state(headers, session))):
            return error("Media not found", 404)
        if not public and asset.uploaded_by != str((staff or {}).get("id")) and (staff or {}).get("role") not in {"admin", "manager"}:
            return error("Media not found", 404)
        if method not in {"GET", "HEAD"}:
            return error("Method not allowed", 405)

        # A storefront card asks for a small re-encode of a stored photo. The
        # original stays the source of truth; the re-encode is durable
        # (built at upload, or once here for an older photo), so this path
        # is a database read — it only avoids shipping the full-resolution
        # master to a 280px thumbnail.
        if asset.kind == "image":
            width = requested_width(query_params)
            # asset.width is metadata: a photo already at or below the
            # asked-for width has no derivative (never upscale), and that
            # is known without touching any blob.
            if width and asset.width > width:
                etag = '"%s-w%d"' % (asset.id, width)
                extra = {
                    "Cache-Control": ("public, max-age=604800, immutable" if public
                                      else "private, max-age=3600"),
                    "ETag": etag,
                }
                # A returning shopper's conditional request is answered
                # from metadata alone when the derivative is already
                # durable — no blob is read just to say "not modified".
                if public and header(headers, "If-None-Match") == etag and (
                        _read_derivative(f"{asset.id}:{width}") is not None
                        or _stored_derivative_exists(session, asset.id, width)):
                    return MediaResponse(304, "image/webp", b"", extra)
                derivative = _resolve_derivative(session, asset, width)
                if derivative is not None:
                    body, mime = derivative
                    extra["Content-Length"] = str(len(body))
                    if public and header(headers, "If-None-Match") == etag:
                        return MediaResponse(304, mime, b"", extra)
                    return MediaResponse(200, mime, b"" if method == "HEAD" else body, extra)

        total = asset.byte_length
        # Media ids are immutable UUIDs whose bytes are never rewritten, so
        # a public master may be cached as aggressively as its derivatives:
        # repeat visits and PDP views skip the network entirely for a week.
        extra = {"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=604800, immutable" if public else "private, no-store"}
        etag = '"' + asset.id + '"'
        extra["ETag"] = etag
        if public and header(headers, "If-None-Match") == etag and not header(headers, "Range"):
            return MediaResponse(304, asset.mime_type, b"", extra)
        start, end, status = 0, total - 1, 200
        requested = header(headers, "Range")
        if requested:
            found = re.fullmatch(r"bytes=(\d*)-(\d*)", requested)
            if not found or not any(found.groups()):
                return error("Invalid media byte range", 416, {"Content-Range": "bytes */" + str(total)})
            a, b = found.groups()
            if a:
                start = int(a); end = min(int(b) if b else total - 1, total - 1)
            else:
                length = int(b); start = max(0, total - length)
                if length <= 0:
                    return error("Invalid media byte range", 416, {"Content-Range": "bytes */" + str(total)})
            if start > end or start >= total:
                return error("Media byte range is outside the file", 416, {"Content-Range": "bytes */" + str(total)})
            status = 206
            extra["Content-Range"] = f"bytes {start}-{end}/{total}"
        length = end - start + 1
        extra["Content-Length"] = str(length)
        # SQL substr works for SQLite blobs and PostgreSQL bytea; no full clip fetch.
        payload = b"" if method == "HEAD" else session.query(func.substr(ProductMedia.data, start + 1, length)).filter_by(id=asset.id).scalar()
        return MediaResponse(status, asset.mime_type, bytes(payload or b""), extra)


def asset_id_from_url(url):
    match = MEDIA_PATH.fullmatch(urllib.parse.urlsplit(str(url or "")).path)
    return match.group(1) if match else None


def attach_to_product(session, product, body, staff):
    """Atomic attachment / removal. Preserve existing media on unrelated edits."""
    assets = list(session.query(ProductMedia).filter_by(product_id=product.id).all())
    images_changed = "images" in body or "image_url" in body
    wanted_images = {asset_id_from_url(url) for url in product.images + [product.image_url]} - {None}
    video_changed = "video_id" in body
    wanted_video = str(body.get("video_id") or "") if video_changed else next((asset.id for asset in assets if asset.kind == "video"), "")
    if wanted_video and not MEDIA_ID.fullmatch(wanted_video):
        raise ValueError("Invalid garment video reference.")
    wanted = wanted_images | ({wanted_video} if wanted_video else set())
    selected = []
    published_promo_ids = published_promo_media_ids(session)
    for asset_id in sorted(wanted):
        asset = session.query(ProductMedia).filter_by(id=asset_id).with_for_update().populate_existing().first()
        if not asset or (asset.product_id and asset.product_id != product.id):
            raise ValueError("An uploaded file is unavailable or belongs to another garment. Upload it again.")
        if asset_id in published_promo_ids:
            raise ValueError("This image is published as storefront artwork. Upload a separate copy for a garment.")
        if not asset.product_id and asset.uploaded_by != str(staff.get("id")) and staff.get("role") not in {"admin", "manager"}:
            raise ValueError("This upload belongs to another staff member.")
        if (asset_id == wanted_video and asset.kind != "video") or (asset_id in wanted_images and asset.kind != "image"):
            raise ValueError("Incorrect photo / video upload type.")
        selected.append(asset)
    for asset in assets:
        if (images_changed and asset.kind == "image" and asset.id not in wanted_images) or (video_changed and asset.kind == "video" and asset.id != wanted_video):
            session.delete(asset)
    for asset in selected:
        asset.product_id = product.id
    session.flush()
    session.expire(product, ["media_assets"])
    return {asset.id for asset in assets} != wanted
