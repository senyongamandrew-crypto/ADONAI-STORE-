#!/usr/bin/env python3
"""
Adonai Store — Factory Reset (Clean 'Day 1' State)
==================================================
Wipes all mock / demo / transactional data from the database while keeping the
schema, migrations, system settings and product categories intact, then
recreates exactly ONE default Admin account so the store can log in
immediately.

What it removes (rows only — tables and columns are preserved):
  • orders, order_items                → sales & receipt history
  • payment_transactions               → online/tender payment logs
  • ledger_entries                     → financial ledger
  • accounting_journal_entries/lines   → accounting journal
  • financial_expenses                 → expense records
  • financial_stock_lots/lot_grades    → batch/lot intake history
  • financial_inventory_adjustments    → inventory adjustment log
  • pos_inventory_locks                → cart/stock reservations
  • inventory                          → per-item stock rows
  • products                           → catalog (left EMPTY for fresh intake)
  • riders                             → demo delivery roster
  • users                              → staff roster (recreated: 1 admin)

What it preserves:
  • Full schema (all tables, columns, constraints, migrations)
  • settings          → system settings / store parameters
  • categories        → standard product taxonomy (reference data)

What it resets:
  • Auto-increment / sequence counters back to 1 (SQLite sqlite_sequence and
    PostgreSQL serial sequences — future-proofing for any integer columns).

Usage:
    python3 scripts/factory_reset.py --yes
    python3 scripts/factory_reset.py --yes --admin-pin 987654 --admin-name "Store Owner"
    python3 scripts/factory_reset.py --dry-run

Environment:
    DATABASE_URL        PostgreSQL connection string (falls back to the local
                        SQLite file adonai.db when unset — same as the app).
    ADONAI_ADMIN_PIN    Default admin PIN when --admin-pin is not passed
                        (fallback default: 1234 — change it after first login).
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import inspect, text  # noqa: E402

from database import Base, engine, get_db, verify_database_connection  # noqa: E402
from models import (  # noqa: E402
    AccountingJournalEntry,
    AccountingJournalLine,
    Category,
    ExpenseRecord,
    Inventory,
    InventoryAdjustment,
    InventoryLock,
    LedgerEntry,
    LotGrade,
    Order,
    OrderItem,
    PaymentTransaction,
    Product,
    Rider,
    StockLot,
    StoreSetting,
    User,
)
from security import hash_pin  # noqa: E402

IS_POSTGRES = engine.url.get_backend_name().startswith("postgresql")

# Child rows first, then parents — keeps referential integrity happy on
# PostgreSQL even when foreign keys are enforced during the wipe.
WIPE_ORDER: tuple[type, ...] = (
    OrderItem,                  # order line items
    PaymentTransaction,         # payment attempts / tender logs
    Order,                      # sales, receipts, order history
    LedgerEntry,                # financial ledger
    AccountingJournalLine,      # journal lines (child of entries)
    AccountingJournalEntry,     # accounting journal
    ExpenseRecord,              # expense records & receipt references
    InventoryAdjustment,        # inventory adjustment log
    LotGrade,                   # grade tiers (children of stock lots)
    StockLot,                   # batch/lot intake history
    InventoryLock,              # cart sessions / stock reservations
    Inventory,                  # per-item stock rows
    Product,                    # full catalog
    Rider,                      # demo delivery roster
    User,                       # staff roster (admin is recreated below)
)

PRESERVED_TABLES = ("settings", "categories")


def reset_autoincrement_counters() -> list[str]:
    """Reset integer auto-increment/sequence counters back to 1."""
    actions: list[str] = []
    inspector = inspect(engine)

    if IS_POSTGRES:
        with engine.connect() as conn:
            for table in inspector.get_table_names():
                for col in inspector.get_columns(table):
                    default = str(col.get("server_default") or "")
                    if "nextval" in default:
                        seq = conn.execute(
                            text("SELECT pg_get_serial_sequence(:t, :c)"),
                            {"t": table, "c": col["name"]},
                        ).scalar()
                        if seq:
                            conn.execute(
                                text(
                                    f'SELECT setval(\'{seq}\', 1, false)'
                                )
                            )
                            actions.append(f"{table}.{col['name']} sequence → 1")
            conn.commit()
    else:
        # SQLite: clear sqlite_sequence so AUTOINCREMENT columns restart at 1.
        with engine.connect() as conn:
            has_seq_table = conn.execute(
                text("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'")
            ).scalar()
            if has_seq_table:
                conn.execute(text("DELETE FROM sqlite_sequence"))
                actions.append("sqlite_sequence → cleared (next auto IDs start at 1)")
            conn.commit()

    return actions


def factory_reset(*, admin_pin: str, admin_name: str, recreate_admin: bool = True) -> dict:
    """Execute the wipe + admin recreation. Returns a summary report dict."""
    report: dict = {"wiped": {}, "preserved": {}, "admin": None, "counters": [], "counts": {}}

    # Ensure every declared table exists before wiping (safe on fresh DBs).
    Base.metadata.create_all(bind=engine)

    with get_db() as session:
        for model in WIPE_ORDER:
            table = model.__tablename__
            deleted = session.query(model).delete(synchronize_session=False)
            report["wiped"][table] = deleted

        # System settings and standard categories are deliberately preserved.
        report["preserved"]["settings"] = session.query(StoreSetting).count()
        report["preserved"]["categories"] = session.query(Category).count()

        if recreate_admin:
            admin = User(
                id="STF-01",
                name=admin_name,
                role="admin",
                pin_hash=hash_pin(admin_pin),
                phone="+256 758 873 398",
                active=True,
            )
            session.add(admin)
            report["admin"] = {"id": admin.id, "name": admin.name, "role": admin.role}

    report["counters"] = reset_autoincrement_counters()

    # Post-registration row counts for the verification printout.
    with engine.connect() as conn:
        inspector = inspect(engine)
        for table in inspector.get_table_names():
            if table.startswith("alembic") or table == "sqlite_sequence":
                continue
            try:
                n = conn.execute(text(f'SELECT COUNT(*) FROM "{table}"')).scalar()
                report["counts"][table] = int(n or 0)
            except Exception:  # noqa: BLE001 — views/odd tables shouldn't kill the report
                continue

    # Compact the local SQLite file so the Day-1 database is physically clean too.
    if not IS_POSTGRES:
        with engine.connect() as conn:
            conn.exec_driver_sql("VACUUM")

    return report


def print_report(report: dict) -> None:
    print("\n" + "=" * 64)
    print("ADONAI STORE — FACTORY RESET REPORT")
    print("=" * 64)

    print("\nWiped (rows deleted):")
    for table, n in report["wiped"].items():
        print(f"  • {table:<32} {n:>6} row(s) removed")

    print("\nPreserved (schema & configuration):")
    for table, n in report["preserved"].items():
        print(f"  • {table:<32} {n:>6} row(s) kept")

    if report["admin"]:
        a = report["admin"]
        print(f"\nDefault admin account recreated: {a['id']} · {a['name']} (role: {a['role']})")

    if report["counters"]:
        print("\nAuto-increment / sequence counters reset:")
        for action in report["counters"]:
            print(f"  • {action}")

    print("\nLive table row counts after reset:")
    for table, n in sorted(report["counts"].items()):
        marker = "  (preserved)" if table in PRESERVED_TABLES else ""
        print(f"  • {table:<32} {n:>6}{marker}")

    print("\nCatalog & inventory are EMPTY and ready for fresh batch/lot intake.")
    print("=" * 64 + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Reset the Adonai Store database to factory Day-1 state.")
    parser.add_argument("--yes", action="store_true", help="Run without interactive confirmation")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be wiped, then exit")
    parser.add_argument("--admin-pin", default=os.environ.get("ADONAI_ADMIN_PIN", "1234"),
                        help="PIN for the recreated default admin (default: 1234 or ADONAI_ADMIN_PIN)")
    parser.add_argument("--admin-name", default=os.environ.get("ADONAI_ADMIN_NAME", "Store Admin"),
                        help="Display name for the recreated default admin")
    parser.add_argument("--no-admin", action="store_true", help="Do not recreate an admin account")
    args = parser.parse_args()

    print("Adonai Store — Factory Reset")
    print(f"Target database: {'PostgreSQL' if IS_POSTGRES else 'local SQLite (dev fallback)'}")

    if not verify_database_connection():
        print("FATAL: could not connect to the database. Check DATABASE_URL.", file=sys.stderr)
        return 1

    if args.dry_run:
        inspector = inspect(engine)
        tables = [t for t in inspector.get_table_names() if t != "sqlite_sequence"]
        wipe_names = {m.__tablename__ for m in WIPE_ORDER}
        print("\nDry run — tables that WOULD be wiped:")
        for t in WIPE_ORDER:
            print(f"  • {t.__tablename__}")
        print("\nTables that WOULD be preserved:")
        for t in tables:
            if t not in wipe_names:
                print(f"  • {t}")
        return 0

    if not args.yes:
        answer = input("This permanently deletes ALL sales, products and staff data. Type RESET to continue: ")
        if answer.strip().upper() != "RESET":
            print("Aborted — no changes were made.")
            return 1

    report = factory_reset(
        admin_pin=args.admin_pin,
        admin_name=args.admin_name,
        recreate_admin=not args.no_admin,
    )
    print_report(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
