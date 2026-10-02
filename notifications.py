"""
Adonai Store — Real-Time Notification Engine (backend broadcaster)

Thread-safe, dependency-free Server-Sent-Events hub for the threaded
http.server stack (serve.py) and the WSGI gateway.

Responsibilities
----------------
1. Fan-out: every business event is pushed to all connected POS/console
   clients through per-subscriber queues (`broadcast_event`).
2. History:  a bounded in-memory ring buffer feeds the notification
   drawer (`recent_events`) so late-joining clients see prior alerts.
3. Access:   EventSource cannot send Authorization headers, and this
   codebase forbids credentials in query strings. Clients therefore
   exchange their staff JWT for a single-use, 60-second *stream ticket*
   (`issue_stream_ticket` / `redeem_stream_ticket`) which is the only
   thing that ever appears in the stream URL.

Event payload schema (serialized as JSON on the `data:` line):
    {
      "id":        "notif_1790975533042",
      "type":      "NEW_ORDER" | "NEW_MESSAGE" | "LOW_STOCK" | "NEW_EXPENSE",
      "title":     "🛍️ New Online Order #1042",
      "message":   "Order received — UGX 129,000",
      "timestamp": 1790975533,
      "payload":   { ... event-specific context ... }
    }
"""

import json
import logging
import queue
import secrets
import threading
import time
from collections import deque

logger = logging.getLogger("adonai.notifications")

# Safety threshold at or below which LOW_STOCK alerts fire (units).
LOW_STOCK_THRESHOLD = 3

# How many notifications the drawer history endpoint retains.
HISTORY_LIMIT = 100

# Per-client outbound buffer. A stalled client never blocks the store.
SUBSCRIBER_QUEUE_SIZE = 64

# Stream tickets: single-use, short-lived handshake values.
TICKET_TTL_SECONDS = 60

_lock = threading.Lock()
_subscribers: list[queue.Queue] = []
_history: deque = deque(maxlen=HISTORY_LIMIT)
_tickets: dict[str, dict] = {}
_sequence = 0


# ----------------------------------------------------------------------
# Subscription management
# ----------------------------------------------------------------------
def subscribe() -> queue.Queue:
    """Register a connected SSE client and return its outbound queue."""
    q = queue.Queue(maxsize=SUBSCRIBER_QUEUE_SIZE)
    with _lock:
        _subscribers.append(q)
        count = len(_subscribers)
    logger.info("Notification stream attached (%d active subscriber(s)).", count)
    return q


def unsubscribe(q: queue.Queue) -> None:
    """Detach a disconnected SSE client."""
    with _lock:
        try:
            _subscribers.remove(q)
        except ValueError:
            pass
        count = len(_subscribers)
    logger.info("Notification stream detached (%d active subscriber(s)).", count)


def subscriber_count() -> int:
    with _lock:
        return len(_subscribers)


# ----------------------------------------------------------------------
# Broadcasting
# ----------------------------------------------------------------------
def broadcast_event(event_type: str, title: str, message: str, payload: dict = None) -> dict:
    """
    Broadcasting utility called from api.py business routes.
    Builds the canonical payload, records it in history, and fans it out
    to every connected client. Never raises — a notification failure must
    not break the business transaction that triggered it.
    """
    global _sequence
    try:
        with _lock:
            _sequence += 1
            seq = _sequence
        event_data = {
            "id": f"notif_{int(time.time() * 1000)}_{seq}",
            "type": str(event_type),
            "title": str(title),
            "message": str(message),
            "payload": payload or {},
            "timestamp": int(time.time()),
        }
        frame = f"data: {json.dumps(event_data, ensure_ascii=False)}\n\n"

        with _lock:
            _history.appendleft(event_data)
            targets = list(_subscribers)

        for sub in targets:
            try:
                sub.put_nowait(frame)
            except queue.Full:
                # Slow/stalled consumer: drop the frame for that client only.
                logger.warning("Dropping notification frame for one slow subscriber.")
            except Exception:
                unsubscribe(sub)
        logger.info("Broadcast %s to %d subscriber(s): %s", event_type, len(targets), title)
        return event_data
    except Exception as exc:  # pragma: no cover — defensive by design
        logger.error("broadcast_event failed silently: %s", exc)
        return {}


def recent_events(limit: int = HISTORY_LIMIT) -> list[dict]:
    """Newest-first notification history for the drawer."""
    with _lock:
        return list(_history)[: max(1, min(int(limit or HISTORY_LIMIT), HISTORY_LIMIT))]


# ----------------------------------------------------------------------
# Stream tickets (header-auth → query-safe single-use handshake)
# ----------------------------------------------------------------------
def issue_stream_ticket(staff: dict) -> str:
    """Exchange an already-verified staff identity for a one-shot stream ticket."""
    ticket = secrets.token_urlsafe(32)
    now = time.time()
    with _lock:
        # Opportunistic purge of expired tickets.
        for key in [k for k, v in _tickets.items() if v["expires"] < now]:
            _tickets.pop(key, None)
        _tickets[ticket] = {
            "staff": {
                "id": (staff or {}).get("id", "STF-TOKEN"),
                "name": (staff or {}).get("name", "Staff Member"),
                "role": (staff or {}).get("role", "staff"),
            },
            "expires": now + TICKET_TTL_SECONDS,
        }
    return ticket


def redeem_stream_ticket(ticket: str) -> dict | None:
    """Validate and consume a stream ticket. Single use, 60s lifetime."""
    if not ticket or len(ticket) > 128:
        return None
    with _lock:
        entry = _tickets.pop(ticket, None)
    if not entry or entry["expires"] < time.time():
        return None
    return entry["staff"]


# ----------------------------------------------------------------------
# SSE frame helpers shared by serve.py (threaded) and the WSGI gateway
# ----------------------------------------------------------------------
def sse_preamble() -> bytes:
    """Initial frames: client retry policy + connected comment."""
    return b"retry: 5000\n\n: connected\n\n"


def next_frame(q: queue.Queue, timeout: float = 25.0) -> bytes:
    """
    Block up to `timeout` seconds for the next event frame.
    Returns a keep-alive comment on timeout so proxies and the client
    know the connection is still healthy.
    """
    try:
        return q.get(timeout=timeout).encode("utf-8")
    except queue.Empty:
        return b": keep-alive\n\n"
