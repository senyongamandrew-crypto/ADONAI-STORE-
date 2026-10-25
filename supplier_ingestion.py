"""Adonai Store — Direct-upload supplier catalog ingestion service.

Architecture
------------
The direct-upload supplier model bypasses multi-tier landed-cost weight
distributions and batch-level invoice allocations. Partners (for example
"Finds Ug") supply pre-photographed jackets, windbreakers and streetwear that
are ingested piece-by-piece: each item record is tagged with its source
supplier identifier (``supplier_name``), assigned a fixed unit cost
(``fixed_unit_cost``) and mapped to a base retail selling price
(``base_retail_price``) upon creation.

This module validates, sanitizes and inserts those items straight into the
Supabase ``catalog_items`` relation. Because every channel (the web
storefront, the admin dashboard and the Android Capacitor POS terminal) reads
the same PostgreSQL state, writes made here propagate to all of them
instantly — no batch sync step is required.

The ``catalog_items`` relation is installed by
``migrations/20261025_direct_supplier_upload.sql``. On Adonai deployments it
is the intake-vocabulary view over ``products``; the migration adds an
INSTEAD OF INSERT trigger so ``insert()`` calls against the view map onto the
physical catalog exactly as if ``catalog_items`` were a table.

Payload contract (transmitted verbatim by every intake form):

    item_name, supplier_name, catalog_group, subcategory, fixed_unit_cost,
    base_retail_price, size_availability, color, image_url, condition_notes,
    created_at

Environment (used by the example execution below):

    SUPABASE_URL  — https://<project-ref>.supabase.co
    SUPABASE_KEY  — service-role key (server-side scripts only)

Usage
-----
    service = SupplierCatalogIngestionService(SUPABASE_URL, SUPABASE_KEY)
    payload = service.sanitize_item_payload(...)
    result = service.ingest_single_item(payload)
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Dict, Optional

# supabase-py is imported defensively so this module can be loaded (and its
# payload sanitizing unit-tested) in environments that only run the REST API.
try:  # pragma: no cover - exercised only when supabase-py is installed
    from supabase import Client, create_client
except ImportError:  # pragma: no cover
    Client = None  # type: ignore[assignment]
    create_client = None  # type: ignore[assignment]


#: The Supabase relation direct uploads are written to.
CATALOG_ITEMS_TABLE = "catalog_items"

#: Values some callers send for ``created_at`` that mean "let the database
#: decide". PostgreSQL rejects them as timestamp literals (the SQL keyword
#: ``NOW()`` is not a valid JSON timestamp value), so the service resolves
#: them to a real ISO-8601 UTC timestamp before insert.
NOW_SENTINELS = {"NOW()", "NOW", "CURRENT_TIMESTAMP", "NOW ()"}

#: NUMERIC(12, 2) cannot express anything beyond this.
MAX_MONEY = Decimal("9999999999.99")


def _normalize_created_at(value: Any) -> str:
    """Return an ISO-8601 UTC timestamp string for the ``created_at`` column.

    ``None`` and the ``NOW()`` / ``CURRENT_TIMESTAMP`` sentinels resolve to the
    current UTC time; anything else must already be an ISO-8601 timestamp.
    """
    if value is None:
        return datetime.now(timezone.utc).isoformat()
    text = str(value).strip()
    if not text or text.upper() in {s.upper() for s in NOW_SENTINELS}:
        return datetime.now(timezone.utc).isoformat()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(
            "created_at must be an ISO-8601 timestamp (or the NOW() sentinel)."
        )
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _money(value: Any, field: str) -> Decimal:
    """Parse one financial figure with Decimal precision; reject junk."""
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a number.")
    try:
        amount = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, AttributeError):
        raise ValueError(f"{field} must be a number.")
    if not amount.is_finite():
        raise ValueError(f"{field} must be a finite number.")
    if amount < 0:
        raise ValueError("Financial figures cannot be negative.")
    if amount > MAX_MONEY:
        raise ValueError(f"{field} cannot exceed {MAX_MONEY}.")
    return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


class SupplierCatalogIngestionService:
    """Validates and inserts direct-upload supplier items into Supabase."""

    def __init__(self, supabase_url: str, supabase_key: str):
        """Initializes the Supabase client for direct-upload item ingestion."""
        if not str(supabase_url or "").strip() or not str(supabase_key or "").strip():
            raise ValueError("Supabase URL and key are required to initialize the service.")
        if create_client is None:
            raise RuntimeError(
                "The 'supabase' package is required for direct-upload ingestion. "
                "Install it with: pip install supabase"
            )
        self.supabase: "Client" = create_client(supabase_url, supabase_key)

    def sanitize_item_payload(
        self,
        item_name: str,
        supplier_name: str,
        catalog_group: str,
        subcategory: str,
        fixed_unit_cost: float,
        base_retail_price: float,
        size_availability: str,
        color: str,
        image_url: str,
        condition_notes: Optional[str] = "Premium Grade 1",
        created_at: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Validates and formats individual item attributes for direct insertion.

        The returned keys are the direct-upload payload contract; admin and POS
        intake forms transmit exactly these fields.

        ``created_at`` is optional. Send an ISO-8601 timestamp, the ``NOW()``
        sentinel, or nothing — the database stamps rows that omit it.
        """
        if not str(item_name or "").strip() or not str(supplier_name or "").strip():
            raise ValueError("Item name and supplier name are required fields.")

        cost_dec = _money(fixed_unit_cost, "fixed_unit_cost")
        price_dec = _money(base_retail_price, "base_retail_price")

        return {
            "item_name": str(item_name).strip(),
            "supplier_name": str(supplier_name).strip(),
            "catalog_group": str(catalog_group or "").strip(),
            "subcategory": str(subcategory or "").strip(),
            "fixed_unit_cost": float(cost_dec),
            "base_retail_price": float(price_dec),
            "size_availability": str(size_availability or "").strip(),
            "color": str(color or "").strip(),
            "image_url": str(image_url or "").strip(),
            "condition_notes": str(condition_notes).strip() if condition_notes else "",
            "created_at": _normalize_created_at(created_at),
        }

    def ingest_single_item(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Inserts a single supplier item record into the Supabase catalog_items table.

        Never raises for database failures — callers (CLI scripts, cron intake
        jobs) receive a ``{"status": "error", "message": ...}`` dictionary they
        can log and retry.
        """
        try:
            response = self.supabase.table(CATALOG_ITEMS_TABLE).insert(payload).execute()
            return {
                "status": "success",
                "data": response.data,
            }
        except Exception as e:
            return {
                "status": "error",
                "message": str(e),
            }


# Example Execution
if __name__ == "__main__":
    URL = os.getenv("SUPABASE_URL", "https://your-project.supabase.co")
    KEY = os.getenv("SUPABASE_KEY", "your-service-role-key")

    service = SupplierCatalogIngestionService(URL, KEY)

    sample_payload = service.sanitize_item_payload(
        item_name="Adidas Red & White Full-Zip Windbreaker",
        supplier_name="Finds Ug",
        catalog_group="Outerwear",
        subcategory="Full-Zip Hooded Windbreaker",
        fixed_unit_cost=45000.00,
        base_retail_price=85000.00,
        size_availability="Medium / Large",
        color="Red / White",
        image_url="https://storage.googleapis.com/adonai-assets/adidas-windbreaker.jpg",
        condition_notes="Excellent vintage condition, inspected and approved.",
    )

    result = service.ingest_single_item(sample_payload)
    print("Ingestion Result:", result)
