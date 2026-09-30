"""
Adonai Thrift Store — Database Initialization & Auto-Migration
Creates all required tables if missing and seeds initial default datasets.
"""
from datetime import datetime, timedelta
import hashlib
import json
import logging
from sqlalchemy import inspect

from database import Base, engine, get_db, verify_database_connection
from models import Category, Inventory, LedgerEntry, Order, OrderItem, Product, Rider, StoreSetting, User

logger = logging.getLogger("adonai.db_init")


def hash_pin(pin: str) -> str:
    """Computes SHA-256 hash for staff PINs."""
    return hashlib.sha256(pin.encode("utf-8")).hexdigest()


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
    logger.info("Verified default staff roster accounts.")


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

    for i, r in enumerate(raw_products):
        pid = f"PRD-{1001 + i}"
        sku = f"ADN-{DEMO_CODES.get(r[3], 'GEN')}-{1001 + i}"
        barcode_id = f"ADT-{10001 + i}"
        created = datetime.utcnow() - timedelta(days=30 - i)
        
        prod = Product(
            id=pid,
            sku=sku,
            barcode_id=barcode_id,
            name=r[0],
            brand=r[1],
            color=r[2],
            demographic=r[3],
            category=r[4],
            size=r[5],
            condition=r[6],
            cost_price=r[7],
            selling_price=r[8],
            compare_price=r[9],
            in_stock_count=r[10],
            desc=r[11],
            image_url=f"assets/products/p{1001 + i}.jpg",
            images_json="[]",
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
        "tagline": "Curated Vintage & Quality Apparel · Kampala, Uganda",
        "whatsapp": "256758873398",
        "phone": "+256 758 873 398",
        "address": "Plot 45 Salama Road, Kibuli / Kampala",
        "currency": "UGX",
        "boda_base_fee": "7000",
        "master_key": "ADONAI-MASTER-2026",
        "receipt_footer": "Thank you for shopping at Adonai Store! Returns accepted within 2 days with valid receipt."
    }
    for k, v in defaults.items():
        existing = session.query(StoreSetting).filter_by(key=k).first()
        if not existing:
            session.add(StoreSetting(key=k, value=v))
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

        logger.info("Database schema verification and auto-migration completed successfully.")
        return True
    except Exception as exc:
        logger.error("[Database Initialization Error] %s", exc, exc_info=True)
        return False


if __name__ == "__main__":
    init_db()
