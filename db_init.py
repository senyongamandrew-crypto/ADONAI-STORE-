"""
Adonai Thrift Store — Database Initialization & Auto-Migration
Creates all required tables if missing and seeds initial default datasets.
"""
from datetime import datetime, timedelta
import json
import logging
import os
import uuid
from sqlalchemy import inspect, text

from database import IS_POSTGRES, Base, engine, get_db, verify_database_connection
from security import hash_pin as pbkdf2_hash_pin
from models import (
    AccountingJournalEntry,
    AccountingJournalLine,
    Category,
    Inventory,
    LedgerEntry,
    Order,
    OrderItem,
    Product,
    Rider,
    StoreSetting,
    User,
    build_product_slug,
    slugify,
)

logger = logging.getLogger("adonai.db_init")


def hash_pin(pin: str) -> str:
    """Hash staff PINs with salted PBKDF2-HMAC-SHA256 (see security.py)."""
    return pbkdf2_hash_pin(pin)


def apply_additive_schema_migrations():
    """Add columns create_all cannot add, without changing or dropping live data."""
    additions = {
        "products": [
            ("stock_lot_id", "VARCHAR(64)"),
            ("inventory_status", "VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE'"),
            ("base_price", "NUMERIC(14,2) NOT NULL DEFAULT 0"),
            ("total_transport_cost", "NUMERIC(14,2) NOT NULL DEFAULT 0"),
            ("embedded_transport_portion", "NUMERIC(14,2) GENERATED ALWAYS AS (total_transport_cost * 0.50) STORED"),
            ("checkout_transport_portion", "NUMERIC(14,2) GENERATED ALWAYS AS (total_transport_cost * 0.50) STORED"),
            ("final_selling_price", "NUMERIC(14,2) GENERATED ALWAYS AS (base_price + (total_transport_cost * 0.50)) STORED"),
            # Product Detail Page (PDP) catalog fields
            ("slug", "VARCHAR(200)"),
            ("fabric", "VARCHAR(255)"),
            ("measurements_json", "TEXT DEFAULT '{}'"),
            ("flaw_notes", "TEXT"),
            ("flaw_photo_index", "INTEGER DEFAULT -1"),
            ("care_notes", "TEXT"),
            ("staff_notes", "TEXT"),
        ],
        "order_items": [
            ("unit_cost", "INTEGER NOT NULL DEFAULT 0"),
            ("category", "VARCHAR(100)"),
        ],
    }
    with engine.begin() as connection:
        schema = inspect(connection)
        for table_name, columns in additions.items():
            existing = {column["name"] for column in schema.get_columns(table_name)}
            for name, declaration in columns:
                if name not in existing:
                    connection.execute(
                        text(f"ALTER TABLE {table_name} ADD COLUMN {name} {declaration}")
                    )
                    logger.info("Added safe column %s.%s", table_name, name)
        # Existing catalog prices predate transport allocation: preserve them as
        # the base price and start with a zero transport allocation.
        connection.execute(text("UPDATE products SET base_price = selling_price WHERE base_price = 0 AND selling_price > 0"))
        for statement in (
            "CREATE INDEX IF NOT EXISTS ix_products_stock_lot_id ON products(stock_lot_id)",
            "CREATE INDEX IF NOT EXISTS ix_products_inventory_status ON products(inventory_status)",
            "CREATE INDEX IF NOT EXISTS ix_products_slug ON products(slug)",
            "CREATE INDEX IF NOT EXISTS ix_order_items_category ON order_items(category)",
        ):
            connection.execute(text(statement))

    backfill_product_slugs()


def backfill_product_slugs():
    """Give every legacy catalog row a shareable /product/<slug> permalink."""
    with get_db() as session:
        rows = session.query(Product).filter(
            (Product.slug.is_(None)) | (Product.slug == "")
        ).all()
        if not rows:
            return
        taken = {
            slug for (slug,) in session.query(Product.slug).filter(
                Product.slug.isnot(None), Product.slug != ""
            ).all()
        }
        for product in rows:
            candidate = build_product_slug(product.name, product.sku, product.id)
            if candidate in taken:
                candidate = f"{candidate}-{slugify(product.id, 'item')}"
            taken.add(candidate)
            product.slug = candidate
        logger.info("Backfilled %d product permalink slugs.", len(rows))


def _journal_line(entry, code, name, debit=0, credit=0, memo=""):
    entry.lines.append(AccountingJournalLine(
        id=f"JLN-{uuid.uuid4().hex[:20].upper()}",
        account_code=code,
        account_name=name,
        debit=max(0, int(debit or 0)),
        credit=max(0, int(credit or 0)),
        memo=memo,
    ))


def backfill_financial_journal(session):
    """Idempotently add balanced history for legacy sales and cash expenses."""
    products = {product.id: product for product in session.query(Product).all()}
    for order in session.query(Order).all():
        source = "pos_sale" if order.channel == "pos" else "web_sale"
        exists = session.query(AccountingJournalEntry).filter_by(
            reference=order.id, source=source
        ).first()
        if exists or str(order.status).lower() in {"cancelled", "void"}:
            continue
        cogs = 0
        for item in order.items:
            product = products.get(item.product_id)
            if not item.unit_cost and product:
                item.unit_cost = int(product.cost_price or 0)
            if not item.category and product:
                item.category = product.category
            cogs += int(item.unit_cost or 0) * int(item.qty or 0)
        account = ("1000", "Cash Drawer")
        if str(order.tender_type).lower() in {"mtn", "airtel", "mobile_money", "mobile"}:
            account = ("1010", "Mobile Money")
        entry = AccountingJournalEntry(
            id=f"JRN-{uuid.uuid4().hex[:20].upper()}",
            reference=order.id,
            source=source,
            description=f"Backfilled {order.channel.upper()} sale {order.id}",
            status="POSTED",
            occurred_at=order.created_at or datetime.utcnow(),
            created_by_id=order.cashier_id,
            created_by_name=order.cashier_name or "System migration",
        )
        _journal_line(entry, account[0], account[1], debit=order.total, memo=order.id)
        _journal_line(entry, "4000", "Sales Revenue", credit=order.total, memo=order.id)
        if cogs:
            _journal_line(entry, "5000", "Cost of Goods Sold", debit=cogs, memo=order.id)
            _journal_line(entry, "1200", "Inventory Asset", credit=cogs, memo=order.id)
        session.add(entry)

    for legacy in session.query(LedgerEntry).filter(LedgerEntry.kind == "expense").all():
        reference = legacy.ref_id or legacy.id
        if session.query(AccountingJournalEntry).filter_by(
            reference=reference, source="legacy_expense"
        ).first():
            continue
        amount = abs(int(legacy.amount or 0))
        if not amount:
            continue
        entry = AccountingJournalEntry(
            id=f"JRN-{uuid.uuid4().hex[:20].upper()}",
            reference=reference,
            source="legacy_expense",
            description=legacy.description or "Legacy expense",
            status="POSTED",
            occurred_at=legacy.created_at or datetime.utcnow(),
            created_by_name=legacy.staff_name or "System migration",
        )
        _journal_line(entry, "5100", "Operating Expense", debit=amount, memo=legacy.category or "")
        _journal_line(entry, "1000", "Cash Drawer", credit=amount, memo=reference)
        session.add(entry)


def seed_categories(session):
    cats = [
        ("Outerwear & Jackets", "JKT", 1, "Vintage jackets, coats, denim truckers, and blazers."),
        ("Tops & Shirts", "TOP", 2, "Oxford button-downs, vintage tees, silk blouses, and polo shirts."),
        ("Dresses & Skirts", "DRS", 3, "Silk slip dresses, Kitenge wraps, and pleated midi skirts."),
        ("Pants & Jeans", "PNT", 4, "High-waist Levi's denim, pleated chinos, and tailored trousers."),
        ("Shoes", "SHO", 5, "Leather Chelsea boots, retro sneakers, and Italian loafers."),
        ("Accessories", "ACC", 6, "Leather belts, canvas field totes, silk scarves, and caps."),
        ("Children Wear", "CHD", 7, "Quality vintage denim and jackets for children.")
    ]
    for name, code, order, desc in cats:
        cat_id = f"CAT-{code}"
        existing = session.query(Category).filter_by(id=cat_id).first()
        if not existing:
            session.add(Category(id=cat_id, name=name, code=code, sort_order=order, description=desc))
    logger.info("Verified standard product categories.")


def seed_users(session):
    # SECURITY: demo staff accounts carry weak, publicly documented PINs.
    # They are only seeded in local/SQLite development, or when the operator
    # explicitly opts in via ADONAI_SEED_DEMO_USERS=1. Production PostgreSQL
    # deployments must create real staff accounts with strong PINs instead.
    if IS_POSTGRES and os.environ.get("ADONAI_SEED_DEMO_USERS") != "1":
        logger.info("Skipping demo staff roster seeding on production database.")
        return
    users = [
        ("STF-01", "Mercer Admin", "admin", hash_pin("1234"), "+256 758 873 398"),
        ("STF-02", "Grace Nakato", "manager", hash_pin("2345"), "+256 772 111 222"),
        ("STF-03", "David Ochieng", "cashier", hash_pin("3456"), "+256 788 333 444"),
        ("STF-04", "Kato Boda", "rider", hash_pin("4567"), "+256 701 555 666")
    ]
    for uid, name, role, pin_h, phone in users:
        existing = session.query(User).filter_by(id=uid).first()
        if not existing:
            session.add(User(id=uid, name=name, role=role, pin_hash=pin_h, phone=phone, active=True))
    logger.info("Verified default staff roster accounts (development seed).")


def seed_products(session):
    existing_count = session.query(Product).count()
    if existing_count > 0:
        logger.info("Products table already populated with %d items.", existing_count)
        return

    DEMO_CODES = {"Men": "MEN", "Women": "WOM", "Children": "KID"}
    raw_products = [
        ("Indigo Type III Trucker Jacket", "Levi's", "Indigo", "Men", "Outerwear & Jackets", "L", "Grade A — Excellent", 40000, 68000, 120000, 1, "1980s trucker jacket. Authentic vintage wash with whiskers and brass buttons intact.", "Rail A-1"),
        ("Olive Waxed Field Jacket", "Barbour Style", "Olive", "Men", "Outerwear & Jackets", "XL", "Grade B — Good", 55000, 85000, 150000, 1, "Matte waxed cotton with a corduroy collar. Windproof and rain-resistant.", "Rail A-2"),
        ("Cream Silk Slip Dress", "Unbranded", "Cream", "Women", "Dresses & Skirts", "S", "Vintage / Collector", 45000, 78000, 130000, 1, "Bias-cut silk slip from the 90s — fluid drape, adjustable straps.", "Rail B-1"),
        ("Black Leather Chelsea Boots", "Clarks", "Black", "Men", "Shoes", "43", "Grade B — Good", 60000, 95000, 170000, 1, "Polished leather uppers with elastic gussets. Resoled once — plenty of life left.", "Shelf S-1"),
        ("White Oxford Button-Down", "Ralph Lauren", "White", "Men", "Tops & Shirts", "L", "Grade A — Excellent", 20000, 38000, 75000, 2, "Crisp cotton oxford with single-needle stitching. Lightly worn.", "Rail C-1"),
        ("Emerald Velvet Tailored Blazer", "Vintage Boutique", "Emerald Green", "Women", "Outerwear & Jackets", "M", "Grade A — Excellent", 35000, 60000, 110000, 1, "Plush cotton-velvet tailored blazer in deep emerald with satin lapels and structured shoulders.", "Rail A-3"),
        ("Pleated Midi Skirt", "Unbranded", "Rust", "Women", "Dresses & Skirts", "M", "Grade A — Excellent", 18000, 35000, 65000, 1, "Satin pleats with a comfortable elastic waist — moves beautifully.", "Rail B-2"),
        ("Ankara Print Wrap Dress", "Hand-made", "Multi", "Women", "Dresses & Skirts", "M", "Grade A — Excellent", 32000, 55000, 95000, 1, "Kitenge wax-print wrap tailored in Kampala. Wears like new.", "Rail B-3"),
        ("High-Waist 501 Jeans", "Levi's", "Mid-wash", "Women", "Pants & Jeans", "30", "Grade B — Good", 26000, 48000, 85000, 2, "Classic straight leg with button fly. Honest fade at the knees.", "Rail D-1"),
        ("Khaki Pleated Chinos", "Dockers", "Khaki", "Men", "Pants & Jeans", "32", "Grade B — Good", 15000, 30000, 55000, 1, "Relaxed pleat-front, freshly hemmed. Office-ready.", "Rail D-2"),
        ("Canvas Field Tote", "Unbranded", "Natural", "Women", "Accessories", "-", "Grade A — Excellent", 10000, 22000, 40000, 1, "Heavy canvas tote with leather handles and a spotless interior.", "Shelf S-2"),
        ("Tan Leather Belt", "Unbranded", "Tan", "Men", "Accessories", "34", "Grade B — Good", 9000, 18000, 32000, 2, "Full-grain leather with a brass buckle — broken in just right.", "Shelf S-3"),
        ("Kids' Denim Jacket", "OshKosh", "Light wash", "Children", "Children Wear", "8y", "Grade B — Good", 13000, 25000, 45000, 1, "Sturdy kids' denim with room to grow. All snaps working.", "Rail K-1"),
        ("Silk Printed Scarf", "Unbranded", "Paisley", "Women", "Accessories", "-", "Vintage / Collector", 13000, 26000, 48000, 1, "Hand-rolled 70s silk square. No pulls, no stains.", "Shelf S-4"),
        ("Retro Running Trainers", "Nike", "White / Gum", "Men", "Shoes", "44", "Grade B — Good", 30000, 55000, 98000, 1, "Retro runner on a gum sole. Cleaned and disinfected.", "Shelf S-5"),
        ("Floral Summer Blouse", "Unbranded", "Floral", "Women", "Tops & Shirts", "S", "Grade A — Excellent", 14000, 28000, 50000, 1, "Airy rayon blouse with covered buttons. Zero pilling.", "Rail C-2")
    ]

    # Flat-lay measurements (INCHES), fabric composition, care and the
    # mandatory flaw disclosure rendered by the Product Detail Page.
    pdp_details = [
        # The hero piece is photographed from four angles (front, back, fabric
        # detail, flaw close-up) to demonstrate the full product page gallery.
        {"measurements": {"shoulder": 18.5, "chest": 22.0, "sleeve": 25.0, "length": 26.0},
         "fabric": "100% Cotton denim · 12.5oz",
         "care": "Machine wash cold inside out. Hang dry. Do not bleach.",
         "flaw": "Light fraying along the left cuff hem and a small pale wear mark just above it. "
                 "The denim is intact — no holes, and every button and rivet is original.",
         "flaw_photo": 3,
         "images": [
             "assets/products/p1001.jpg",
             "assets/products/p1001-back.jpg",
             "assets/products/p1001-fabric.jpg",
             "assets/products/p1001-flaw.jpg",
         ]},
        {"measurements": {"shoulder": 19.5, "chest": 24.0, "sleeve": 26.0, "length": 31.0},
         "fabric": "Waxed cotton shell · corduroy collar · polyester lining",
         "care": "Do not machine wash. Sponge clean with cold water and re-wax once a year.",
         "flaw": "Wax finish has faded slightly at both cuffs and there is a neat 1-inch seam repair inside the left pocket. Fully weatherproof and structurally sound."},
        {"measurements": {"chest": 17.0, "waist": 16.0, "length": 51.0},
         "fabric": "100% Silk",
         "care": "Dry clean, or cold hand wash with silk detergent and dry flat.",
         "flaw": "Two faint pin marks beside the left strap from the original hemming — only visible up close."},
        {"measurements": {"insole": 11.0, "heel": 1.2},
         "fabric": "Full-grain leather upper · leather sole · elastic gusset",
         "care": "Wipe with a damp cloth and polish monthly. Use shoe trees between wears.",
         "flaw": "Resoled once by a cobbler and light creasing across the toe box. Uppers are crack-free."},
        {"measurements": {"shoulder": 18.0, "chest": 22.5, "sleeve": 25.0, "length": 30.0},
         "fabric": "100% Cotton oxford",
         "care": "Machine wash warm, tumble dry low, iron on medium.",
         "flaw": ""},
        {"measurements": {"shoulder": 15.5, "chest": 19.0, "sleeve": 23.0, "length": 26.0},
         "fabric": "Cotton velvet · satin lapels · viscose lining",
         "care": "Dry clean only. Steam lightly to lift the pile.",
         "flaw": ""},
        {"measurements": {"waist": 13.0, "hip": 19.0, "length": 31.0},
         "fabric": "Polyester satin · elastic waistband",
         "care": "Hand wash cold, hang dry, cool iron on the reverse.",
         "flaw": ""},
        {"measurements": {"shoulder": 14.5, "chest": 18.0, "sleeve": 9.0, "length": 44.0},
         "fabric": "100% Cotton wax print (Kitenge)",
         "care": "Wash separately on the first wash — wax-print colours may run.",
         "flaw": ""},
        {"measurements": {"waist": 15.0, "hip": 20.0, "inseam": 29.0, "rise": 11.5, "thigh": 11.0, "leg_opening": 7.5},
         "fabric": "100% Cotton rigid denim",
         "care": "Machine wash cold inside out. Line dry to keep the fade.",
         "flaw": "Honest fade across both knees and a small frayed edge on the right back pocket. No holes or repairs."},
        {"measurements": {"waist": 16.5, "hip": 21.0, "inseam": 30.0, "rise": 11.0, "thigh": 12.0, "leg_opening": 8.0},
         "fabric": "Cotton twill",
         "care": "Machine wash warm, tumble dry low, iron the pleats.",
         "flaw": "Faint shadow at the original hem line where the leg was let down. Hem professionally re-stitched."},
        {"measurements": {"length": 15.0, "notes": "Body 14in wide x 15in tall x 5in deep · 11in handle drop"},
         "fabric": "Heavy cotton canvas · leather handles",
         "care": "Spot clean with mild soap. Air dry out of direct sun.",
         "flaw": ""},
        {"measurements": {"length": 42.0, "notes": "Fits a 32in–36in waist · 1.5in strap width"},
         "fabric": "Full-grain leather · solid brass buckle",
         "care": "Condition with leather balm twice a year.",
         "flaw": "Buckle carries a light patina and the third hole shows normal wear."},
        {"measurements": {"shoulder": 12.5, "chest": 15.0, "sleeve": 17.0, "length": 17.0},
         "fabric": "Cotton denim",
         "care": "Machine wash cold, tumble dry low.",
         "flaw": "One snap shows minor tarnish. Every snap opens and closes properly."},
        {"measurements": {"length": 26.0, "notes": "26in x 26in square with a hand-rolled hem"},
         "fabric": "100% Silk",
         "care": "Dry clean only.",
         "flaw": ""},
        {"measurements": {"insole": 11.2},
         "fabric": "Suede and mesh upper · gum rubber outsole",
         "care": "Brush suede dry. Spot clean the midsole with mild soap.",
         "flaw": "Even tread wear across the outsole. Interior washed, disinfected and odour-free."},
        {"measurements": {"shoulder": 14.0, "chest": 18.0, "sleeve": 7.0, "length": 24.0},
         "fabric": "100% Rayon",
         "care": "Hand wash cold, line dry, cool iron.",
         "flaw": ""},
    ]

    for i, r in enumerate(raw_products):
        pid = f"PRD-{1001 + i}"
        sku = f"ADN-{DEMO_CODES.get(r[3], 'GEN')}-{1001 + i}"
        barcode_id = f"ADT-{10001 + i}"
        created = datetime.utcnow() - timedelta(days=30 - i)
        details = pdp_details[i] if i < len(pdp_details) else {}

        prod = Product(
            id=pid,
            sku=sku,
            slug=build_product_slug(r[0], sku, pid),
            barcode_id=barcode_id,
            name=r[0],
            brand=r[1],
            color=r[2],
            demographic=r[3],
            category=r[4],
            size=r[5],
            condition=r[6],
            cost_price=r[7],
            # base_price must be seeded too: final_selling_price is a generated
            # column (base_price + 50% transport). Leaving it at 0 made a fresh
            # database advertise every piece as "UGX 0" on the storefront.
            base_price=r[8],
            total_transport_cost=0,
            selling_price=r[8],
            compare_price=r[9],
            in_stock_count=r[10],
            desc=r[11],
            image_url=f"assets/products/p{1001 + i}.jpg",
            images_json=json.dumps(details.get("images", [])),
            fabric=details.get("fabric", ""),
            measurements_json=json.dumps(details.get("measurements", {})),
            flaw_notes=details.get("flaw", ""),
            flaw_photo_index=details.get("flaw_photo", -1),
            care_notes=details.get("care", ""),
            rack_location=r[12],
            created_at=created
        )
        session.add(prod)

        # Corresponding initial inventory record
        session.add(Inventory(
            id=f"INV-{1001 + i}",
            product_id=pid,
            sku=sku,
            rack_location=r[12],
            quantity=r[10],
            batch_reference="BATCH-2026-Q3-INIT",
            intake_date=created,
            intake_staff_id="STF-01",
            notes="Initial curated inventory intake"
        ))
    logger.info("Seeded %d initial product catalog items and inventory records.", len(raw_products))


def seed_settings(session):
    defaults = {
        "store_name": "Adonai Thrift Store",
        "tagline": "Curated pre-loved vintage · Laundered, graded and sold once",
        "whatsapp": "256758873398",
        "whatsapp_display": "+256 758 873 398",
        "phone": "+256 758 873 398",
        "hotline": "+256 765 652 403",
        "email": "adonaithriftstore@gmail.com",
        "tiktok": "@adonai.thrift256",
        "instagram": "@adonaithrift256",
        "address": "Plot 45 Salama Road / Kibuli, Kampala, Uganda",
        "hours": "Mon - Sat: 8:30 AM - 7:30 PM | Sun: 10:00 AM - 6:00 PM",
        "delivery_scope": "Uganda (Central, Eastern, and Western regions)",
        "currency": "UGX",
        "base_delivery_fee": "7000",
        "boda_base_fee": "7000",
        # SECURITY: no default master_key is seeded. Admin access comes from
        # the ADMIN_ACCESS_PIN / ADMIN_KEY environment variables, or a key the
        # owner sets in System Parameters after signing in.
        "receipt_footer": "Thank you for shopping at Adonai Store! Returns accepted within 2 days with valid receipt."
    }
    for k, v in defaults.items():
        existing = session.query(StoreSetting).filter_by(key=k).first()
        if not existing:
            session.add(StoreSetting(key=k, value=v))

    # Hardening migration: purge the retired, publicly known default key from
    # databases seeded by earlier releases so it can never authenticate again.
    retired = {"adonai-master-2026"}
    for key_name in ("master_key", "admin_key", "terminal_key", "staff_key"):
        row = session.query(StoreSetting).filter_by(key=key_name).first()
        if row and str(row.value or "").strip().lower() in retired:
            session.delete(row)
            logger.warning(
                "Removed retired default credential from store setting '%s'. "
                "Set a new key in System Parameters or via environment variables.",
                key_name,
            )
    logger.info("Verified core store settings.")


def seed_riders(session):
    riders = [
        ("RID-01", "Kato Ivan", "+256 701 555 666", "Available", "UEP 123X"),
        ("RID-02", "Mugisha Ronald", "+256 772 888 999", "Available", "UFE 456Y")
    ]
    for rid, name, phone, status, plate in riders:
        existing = session.query(Rider).filter_by(id=rid).first()
        if not existing:
            session.add(Rider(id=rid, name=name, phone=phone, status=status, vehicle_plate=plate))
    logger.info("Verified delivery rider roster.")


def seed_sample_sales(session):
    existing_orders = session.query(Order).count()
    if existing_orders > 0:
        return

    # Sample completed walk-in sale matching console walkthrough
    order_id = "AT-1841"
    order = Order(
        id=order_id,
        channel="pos",
        status="completed",
        dispatch_status="Delivered",
        customer_name="Amina Namubiru",
        customer_phone="+256772123456",
        customer_address="Walk-in Store",
        delivery_type="pickup",
        delivery_fee=0,
        subtotal=68000,
        total=68000,
        tender_type="cash",
        tender_amount=70000,
        tender_change=2000,
        cashier_id="STF-03",
        cashier_name="David Ochieng",
        created_at=datetime.utcnow() - timedelta(hours=26)
    )
    session.add(order)
    session.add(OrderItem(
        id="ITEM-1841-1",
        order_id=order_id,
        product_id="PRD-1001",
        barcode_id="ADT-10001",
        name="Indigo Type III Trucker Jacket",
        unit_price=68000,
        qty=1,
        line_total=68000
    ))

    # Ledger entry for the sale
    session.add(LedgerEntry(
        id="LED-1001",
        kind="sale",
        amount=68000,
        category="In-Store POS",
        description="Sale AT-1841 (Indigo Type III Trucker Jacket)",
        staff_name="David Ochieng",
        ref_id=order_id,
        created_at=datetime.utcnow() - timedelta(hours=26)
    ))
    logger.info("Seeded initial baseline sales and ledger records.")


def init_db() -> bool:
    """
    Initializes database tables and verifies schema on startup.
    Executes safely with idempotency.
    """
    try:
        if not verify_database_connection():
            logger.critical("Database connection check failed during startup.")
            return False

        # Create all declared tables if they do not exist
        logger.info("Verifying and auto-migrating database schema tables...")
        Base.metadata.create_all(bind=engine)
        apply_additive_schema_migrations()

        inspector = inspect(engine)
        tables = inspector.get_table_names()
        logger.info("Live tables in database: %s", ", ".join(tables))

        # Seed essential defaults inside an atomic transaction
        with get_db() as session:
            seed_categories(session)
            seed_users(session)
            seed_settings(session)
            seed_riders(session)
            seed_products(session)
            seed_sample_sales(session)
            backfill_financial_journal(session)

        logger.info("Database schema verification and auto-migration completed successfully.")
        return True
    except Exception as exc:
        logger.error("[Database Initialization Error] %s", exc, exc_info=True)
        return False


if __name__ == "__main__":
    init_db()
