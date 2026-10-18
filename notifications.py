"""Durable operator notifications, with optional cross-worker SSE delivery.

Business routes pass their existing SQL session to ``broadcast_event``: an
alert commits (or rolls back) with the action, never ahead of it. History
polling is the default client transport, so small threaded Gunicorn pools do
not need to hold an SSE connection open for every cashier. Legacy SSE clients
also read committed SQL history and use shared, hashed, one-use tickets.
"""
from collections import deque
from datetime import datetime, timedelta
import hashlib
import json
import logging
import queue
import secrets
import threading
import time
import uuid

from sqlalchemy import delete
from database import get_db
from models import NotificationEvent, NotificationStreamTicket

logger = logging.getLogger("adonai.notifications")
LOW_STOCK_THRESHOLD = 3
HISTORY_LIMIT = 100
TICKET_TTL_SECONDS = 60
STREAM_POLL_SECONDS = 1.0
_lock = threading.Lock()
_subscribers = []


def _source_key(event_type, payload):
    # Creation events can be safely recovered from existing rows on upgrade.
    field = {"NEW_ORDER": "order_id", "STOCK_ADDED": "product_id", "NEW_EXPENSE": "expense_id"}.get(event_type)
    if not field or not payload.get(field):
        return None
    source = f"{event_type}:{payload[field]}"
    # A permanently deleted catalog ID may legitimately be reused. The
    # creation time distinguishes that new intake from its historical row.
    if event_type == "STOCK_ADDED" and payload.get("created_at"):
        source += ":" + str(payload["created_at"])
    return source


def broadcast_event(event_type, title, message, payload=None, *, session=None):
    """Record activity in the caller's transaction (or a standalone one).

    Do NOT open a nested get_db() inside a business transaction: this app uses
    scoped sessions. Every API caller must pass ``session=session``.
    Only committed rows are observable by history and stream clients.
    """
    created_at = datetime.utcnow()
    payload_json = json.dumps(payload or {}, ensure_ascii=False)
    row = NotificationEvent(
        id="notif_" + uuid.uuid4().hex, event_type=str(event_type)[:40],
        title=str(title)[:255], message=str(message), payload_json=payload_json,
        source_key=_source_key(str(event_type), payload or {}), created_at=created_at,
    )
    event_data = row.to_dict()
    if session is not None:
        session.add(row)
    else:
        with get_db() as db:
            db.add(row)
    return event_data


def recent_events(limit=HISTORY_LIMIT, *, session=None):
    """Newest-first committed history, independent of process/restart."""
    limit = max(1, min(int(limit or HISTORY_LIMIT), HISTORY_LIMIT))
    if session is None:
        with get_db() as db:
            return recent_events(limit, session=db)
    return [row.to_dict() for row in session.query(NotificationEvent).filter(
        NotificationEvent.deleted_at.is_(None),
    ).order_by(
        NotificationEvent.created_at.desc(), NotificationEvent.id.desc(),
    ).limit(limit).all()]


DELETE_BATCH_LIMIT = 200


def delete_events(ids, *, staff=None, session=None):
    """Permanently remove alerts from the bell on every device.

    Only the notification is removed; the order, sale, stock or expense it
    describes is never touched. Rows become tombstones (``deleted_at``) so
    ``backfill_history`` cannot recreate them on the next deployment.
    Returns the number of alerts that were deleted by this call.
    """
    clean = []
    for value in ids or []:
        if isinstance(value, str) and 0 < len(value) <= 64 and value not in clean:
            clean.append(value)
    clean = clean[:DELETE_BATCH_LIMIT]
    if not clean:
        return 0
    if session is None:
        with get_db() as db:
            return delete_events(clean, staff=staff, session=db)
    who = str((staff or {}).get("name") or (staff or {}).get("id") or "staff")[:120]
    return session.query(NotificationEvent).filter(
        NotificationEvent.id.in_(clean), NotificationEvent.deleted_at.is_(None),
    ).update({"deleted_at": datetime.utcnow(), "deleted_by": who}, synchronize_session=False)


def backfill_history(session):
    """Recover recent *actual* activity on upgrade, without demo alerts.

    Deterministic creation source keys + ON CONFLICT make this idempotent
    across deployments and concurrent startup workers. Existing objects are
    never edited, and their original timestamps are preserved.
    """
    from models import Order, Product, ExpenseRecord
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert
    insert = pg_insert if session.get_bind().dialect.name == "postgresql" else sqlite_insert
    session.flush()
    candidates = []
    for order in session.query(Order).order_by(Order.created_at.desc()).limit(HISTORY_LIMIT).all():
        candidates.append(("NEW_ORDER", "Checkout recorded" if order.channel == "pos" else "Order received",
            f"Order {order.id} · UGX {int(order.total or 0):,}",
            {"order_id": order.id, "amount": int(order.total or 0), "customer": order.customer_name, "channel": order.channel}, order.created_at))
    for product in session.query(Product).order_by(Product.created_at.desc()).limit(HISTORY_LIMIT).all():
        candidates.append(("STOCK_ADDED", "Stock intake saved", f"{product.name} was added to the catalog.",
            {"product_id": product.id, "name": product.name, "barcode": product.barcode_id,
             "created_at": product.created_at.isoformat() if product.created_at else None}, product.created_at))
    for expense in session.query(ExpenseRecord).order_by(ExpenseRecord.created_at.desc()).limit(HISTORY_LIMIT).all():
        candidates.append(("NEW_EXPENSE", "Expense logged", f"{expense.category} · UGX {int(expense.amount or 0):,}",
            {"expense_id": expense.id, "amount": int(expense.amount or 0), "category": expense.category}, expense.created_at))
    candidates.sort(key=lambda item: item[4] or datetime.min, reverse=True)
    for kind, title, message, payload, created_at in candidates[:HISTORY_LIMIT]:
        source = _source_key(kind, payload)
        stmt = insert(NotificationEvent).values(
            id="notif_" + hashlib.sha256(source.encode()).hexdigest()[:32],
            event_type=kind, title=title, message=message,
            payload_json=json.dumps(payload, ensure_ascii=False), source_key=source,
            created_at=created_at or datetime.utcnow(),
        ).on_conflict_do_nothing(index_elements=["source_key"])
        session.execute(stmt)


def _digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def issue_stream_ticket(staff):
    """Store only hashes of tickets/area tokens, never JWTs or passwords."""
    from access_control import _tokens
    ticket = secrets.token_urlsafe(32)
    identity = {key: (staff or {}).get(key, default) for key, default in (
        ("id", "STF-TOKEN"), ("name", "Staff Member"), ("role", "staff"))}
    identity["_pos_access_token_hashes"] = [_digest(token) for token in _tokens({
        "x-pos-access": (staff or {}).get("_pos_access_tokens", ""),
    })]
    now = datetime.utcnow()
    with get_db() as session:
        session.query(NotificationStreamTicket).filter(NotificationStreamTicket.expires_at <= now).delete(synchronize_session=False)
        session.add(NotificationStreamTicket(ticket_hash=_digest(ticket), staff_json=json.dumps(identity),
            expires_at=now + timedelta(seconds=TICKET_TTL_SECONDS)))
    return ticket


def redeem_stream_ticket(ticket):
    """Atomic consume; a ticket works once, even on a different worker."""
    if not isinstance(ticket, str) or not 32 <= len(ticket) <= 128:
        return None
    with get_db() as session:
        identity = session.execute(delete(NotificationStreamTicket).where(
            NotificationStreamTicket.ticket_hash == _digest(ticket),
            NotificationStreamTicket.expires_at > datetime.utcnow(),
        ).returning(NotificationStreamTicket.staff_json)).scalar_one_or_none()
        return json.loads(identity) if identity else None


def subscribe():
    q = queue.Queue()
    q.pending_frames = deque()
    q.seen_ids = {event["id"] for event in recent_events()}
    with _lock:
        _subscribers.append(q)
    return q


def unsubscribe(q):
    with _lock:
        if q in _subscribers:
            _subscribers.remove(q)


def subscriber_count():
    with _lock:
        return len(_subscribers)


def sse_preamble():
    return b"retry: 5000\n\n: connected\n\n"


def next_frame(q, timeout=25.0):
    """Read committed events across workers; don't miss late commits."""
    deadline = time.monotonic() + timeout
    while True:
        if q.pending_frames:
            return q.pending_frames.popleft()
        history = recent_events()
        for event in reversed(history):
            if event["id"] not in q.seen_ids:
                q.pending_frames.append(("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode("utf-8"))
        q.seen_ids = {event["id"] for event in history}
        if q.pending_frames:
            continue
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return b": keep-alive\n\n"
        time.sleep(min(STREAM_POLL_SECONDS, remaining))
