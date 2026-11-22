"""Sequential, never-reused stock-tag codes for small thermal labels.

A printed tag is physical and permanent. It has to resolve to exactly one
catalog piece for as long as the label stays on the garment, so codes are
allocated once, in order, and are never recycled:

* a hash-derived code can collide with another piece (and then a scan picks
  the wrong garment — a stock error the shop cannot see until it counts),
* a positional code ("row 3, item 2") silently points somewhere else as soon
  as the rack is reorganised.

Codes are plain digits so they survive Code 128 at 32 × 16 mm: a 4-digit code
is 99 modules wide, which still leaves a 0.3 mm bar on an 80 mm roll.
"""

from __future__ import annotations

import re
import logging

from sqlalchemy.exc import IntegrityError

logger = logging.getLogger("adonai.tag_codes")

# 1001 is the first tag: 4 digits from the start, so the printed width is
# predictable today and the 5th digit (at 10,000 pieces) still fits the label.
TAG_CODE_START = 1001
TAG_CODE_CEILING = 999999
TAG_CODE_MIN_LENGTH = 4

_CODE_RE = re.compile(r"^(\d{4,6})$")


def normalize_tag_code(value) -> str:
    """Fold what staff might type ("T-1042", " 1042 ") into the stored code."""
    text = str(value or "").strip().upper()
    # Staff type the code as it is spoken ("T-1042", "t 1042"). Only that
    # prefix is forgiven: an interior separator ("1042-1") is a different
    # string and must never fold onto the label of another piece.
    text = re.sub(r"^T[\s\-]*", "", text).strip()
    return text if _CODE_RE.match(text) else ""


def format_tag_code(number: int) -> str:
    number = int(number)
    return f"{number:04d}" if number < 10000 else str(number)


def parse_tag_number(value) -> int:
    code = normalize_tag_code(value)
    return int(code) if code else 0


def next_tag_number(session) -> int:
    """The next free number above everything already printed.

    Read as a set rather than with MAX(CAST(...)): the column is VARCHAR and
    a cast fails on PostgreSQL the moment one row holds a non-numeric legacy
    value, which would take the whole intake request down.
    """
    from models import Product

    highest = 0
    for (code,) in session.query(Product.tag_code).filter(Product.tag_code.isnot(None)).all():
        number = parse_tag_number(code)
        if number > highest:
            highest = number
    return max(TAG_CODE_START, highest + 1)


def allocate_tag_code(session, product, attempts: int = 8) -> str:
    """Give ``product`` its permanent tag code, reusing one it already has.

    The insert is probed inside a savepoint: two phones registering stock at
    the same moment must not make the second registration fail, and a unique
    index is the only thing that can actually stop a duplicate label.
    """
    from models import Product

    existing = normalize_tag_code(product.tag_code)
    if existing:
        if existing != product.tag_code:
            product.tag_code = existing
        return existing

    number = next_tag_number(session)
    for _ in range(attempts):
        if number > TAG_CODE_CEILING:
            logger.error("Tag codes are exhausted above %s.", TAG_CODE_CEILING)
            return ""
        code = format_tag_code(number)
        taken = session.query(Product.id).filter(Product.tag_code == code).first()
        if taken is None:
            try:
                with session.begin_nested():
                    product.tag_code = code
                    session.flush()
                return code
            except IntegrityError:
                product.tag_code = None
        number += 1
    logger.error("Could not allocate a tag code for product %s.", getattr(product, "id", "?"))
    return ""


def backfill_tag_codes(session) -> int:
    """Stamp every legacy row (and direct-upload insert) with a stable code.

    Numbers advance locally instead of re-scanning the catalog per row: a
    shop with a few thousand pieces would otherwise spend thousands of round
    trips before its register opens.
    """
    from models import Product

    rows = (
        session.query(Product)
        .filter((Product.tag_code.is_(None)) | (Product.tag_code == ""))
        .order_by(Product.created_at.asc(), Product.id.asc())
        .all()
    )
    if not rows:
        return 0
    taken = {
        normalize_tag_code(code)
        for (code,) in session.query(Product.tag_code).filter(Product.tag_code.isnot(None)).all()
    }
    number = next_tag_number(session)
    assigned = 0
    for product in rows:
        code = ""
        while number <= TAG_CODE_CEILING:
            candidate = format_tag_code(number)
            number += 1
            if candidate not in taken:
                code = candidate
                break
        if not code:
            break
        product.tag_code = code
        taken.add(code)
        assigned += 1
    if assigned:
        session.flush()
        logger.info("Assigned %s stock-tag codes.", assigned)
    return assigned
