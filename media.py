"""Managed garment photos and short videos, durable in PostgreSQL / SQLite.

No uploaded bytes are put in catalog JSON or localStorage. Temporary drafts are
private, attachment is part of the product transaction, and ranged video reads
select only the requested byte slice. No ephemeral Render filesystem dependency.
"""
from datetime import datetime, timedelta
import io
import json
import os
import re
import struct
import subprocess
import tempfile
import urllib.parse
import uuid
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import func

import access_control
from database import get_db
from models import Product, ProductMedia

MAX_IMAGES = 12
MAX_IMAGE_UPLOAD = 10 * 1024 * 1024
MAX_VIDEO_UPLOAD = 50 * 1024 * 1024
MAX_VIDEO_SECONDS = 30
MAX_STORED_VIDEO = 12 * 1024 * 1024
MEDIA_ID = re.compile(r"^[0-9a-f]{32}$")
MEDIA_PATH = re.compile(r"^/api/media/([0-9a-f]{32})$")


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
    if path.rstrip("/") == "/api/media/videos":
        return MAX_VIDEO_UPLOAD
    if path.rstrip("/") == "/api/media/images":
        return MAX_IMAGE_UPLOAD
    return None


def prepare_image(data):
    if not data or len(data) > MAX_IMAGE_UPLOAD:
        raise ValueError("Choose an image smaller than 10 MB.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as original:
                if original.format not in {"JPEG", "PNG", "WEBP", "HEIF"}:
                    raise ValueError("Choose a JPG, PNG or WebP photo.")
                if original.width * original.height > 30_000_000:
                    raise ValueError("This image is too large. Export a smaller phone photo.")
                image = ImageOps.exif_transpose(original).convert("RGB")
                image.thumbnail((1200, 1200))
                output = io.BytesIO()
                image.save(output, "JPEG", quality=82, optimize=True)
                return output.getvalue(), image.width, image.height
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("The photo could not be read. Export it as JPG or PNG and try again.") from exc


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


def route_request(method, path, data, headers, staff):
    """Called after existing staff + optional stock-area authorization."""
    if path in {"/api/media/images", "/api/media/videos"} and method == "POST":
        try:
            if path.endswith("images"):
                prepared, width, height = prepare_image(data)
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
            # Unattached drafts are private and expire after a day, not forever.
            session.query(ProductMedia).filter(ProductMedia.product_id.is_(None),
                ProductMedia.created_at < datetime.utcnow() - timedelta(days=1)).delete(synchronize_session=False)
            asset = ProductMedia(id=uuid.uuid4().hex, kind=kind, mime_type=mime,
                filename=filename, byte_length=len(prepared), width=width, height=height,
                duration=duration, data=prepared, uploaded_by=str(staff.get("id", "OPEN-TERMINAL")))
            session.add(asset); session.flush()
            return MediaResponse(201, "application/json; charset=utf-8", json.dumps({"ok": True, "media": asset.to_dict()}).encode())
    match = MEDIA_PATH.fullmatch(path)
    if not match:
        return error("Media route not found", 404)
    with get_db() as session:
        query = session.query(ProductMedia).filter_by(id=match.group(1))
        asset = (query.with_for_update() if method == "DELETE" else query).first()
        if not asset:
            return error("Media not found", 404)
        if method == "DELETE":
            if asset.product_id:
                return error("Save the garment without this media to remove it.", 409)
            if asset.uploaded_by != str(staff.get("id")) and staff.get("role") not in {"admin", "manager"}:
                return error("Media not found", 404)
            session.delete(asset)
            return MediaResponse(200, "application/json; charset=utf-8", b'{"ok": true}')
        public = bool(asset.product_id and asset.product and asset.product.inventory_status not in {"ARCHIVED", "WRITTEN_OFF"})
        if not public and (not staff or not access_control.allowed("stock", access_control.state(headers, session))):
            return error("Media not found", 404)
        if not public and asset.uploaded_by != str((staff or {}).get("id")) and (staff or {}).get("role") not in {"admin", "manager"}:
            return error("Media not found", 404)
        if method not in {"GET", "HEAD"}:
            return error("Method not allowed", 405)
        total = asset.byte_length
        extra = {"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400" if public else "private, no-store"}
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
    for asset_id in sorted(wanted):
        asset = session.query(ProductMedia).filter_by(id=asset_id).with_for_update().populate_existing().first()
        if not asset or (asset.product_id and asset.product_id != product.id):
            raise ValueError("An uploaded file is unavailable or belongs to another garment. Upload it again.")
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
