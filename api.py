"""
Adonai Thrift Store — REST API & Service Layer
Provides RESTful JSON endpoints connected to the PostgreSQL database for products,
orders, inventory, POS sales, dispatch logistics, ledger, and staff authentication.
"""
from datetime import datetime
import hashlib
import json
import logging
import os
from sqlalchemy import inspect, or_, text

import time
import uuid

from database import DATABASE_URL, IS_POSTGRES, engine, get_db
from models import Category, Inventory, LedgerEntry, Order, OrderItem, Product, Rider, StoreSetting, User

logger = logging.getLogger("adonai.api")


def generate_uid(prefix: str = "ID") -> str:
    """Generates unique collision-safe identifier with millisecond timestamp + random suffix."""
    return f"{prefix}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:6].upper()}"


def json_response(data, status=200):
    """Formats Python data into standard HTTP JSON payload."""
    payload = json.dumps(data, default=str)
    return status, "application/json; charset=utf-8", payload.encode("utf-8")


def handle_api_request(method: str, path: str, query_params: dict, body_bytes: bytes) -> tuple[int, str, bytes]:
    """
    Unified router for backend /api/* endpoints.
    Returns (status_code, content_type, response_body_bytes).
    """
    try:
        body = {}
        if body_bytes and method in ("POST", "PUT", "PATCH"):
            try:
                body = json.loads(body_bytes.decode("utf-8"))
            except Exception:
                body = {}

        # Strip trailing slashes from path
        clean_path = path.rstrip("/")

        # ----------------------------------------------------
        # 1. Health & Status
        # ----------------------------------------------------
        if clean_path == "/api/health" and method == "GET":
            inspector = inspect(engine)
            tables = inspector.get_table_names()
            pool_info = {}
            if hasattr(engine.pool, "size"):
                pool_info = {
                    "size": engine.pool.size(),
                    "checkedin": engine.pool.checkedin(),
                    "checkedout": engine.pool.checkedout(),
                    "overflow": engine.pool.overflow()
                }

            return json_response({
                "status": "healthy",
                "database": "connected",
                "dialect": engine.dialect.name,
                "is_postgres": IS_POSTGRES,
                "tables_count": len(tables),
                "tables": tables,
                "pool": pool_info,
                "timestamp": datetime.utcnow().isoformat()
            })

        # ----------------------------------------------------
        # 2. Products API
        # ----------------------------------------------------
        if clean_path == "/api/products" and method == "GET":
            with get_db() as session:
                q = session.query(Product)
                
                # Search filter
                search = query_params.get("search", [""])[0].strip().lower()
                if search:
                    pattern = f"%{search}%"
                    q = q.filter(or_(
                        Product.name.ilike(pattern),
                        Product.brand.ilike(pattern),
                        Product.sku.ilike(pattern),
                        Product.barcode_id.ilike(pattern),
                        Product.desc.ilike(pattern)
                    ))
                
                # Demographic filter
                demo = query_params.get("demographic", [""])[0]
                if demo and demo != "All":
                    q = q.filter(Product.demographic == demo)

                # Category filter
                cat = query_params.get("category", [""])[0]
                if cat and cat != "All":
                    q = q.filter(Product.category == cat)

                # Condition filter
                cond = query_params.get("condition", [""])[0]
                if cond and cond != "All":
                    q = q.filter(Product.condition == cond)

                # Max price filter
                if "max_price" in query_params:
                    try:
                        max_p = int(query_params["max_price"][0])
                        q = q.filter(Product.selling_price <= max_p)
                    except ValueError:
                        pass

                # Sort: in-stock first, then newest
                q = q.order_by(Product.in_stock_count.desc(), Product.created_at.desc())
                prods = [p.to_dict() for p in q.all()]
                return json_response({"count": len(prods), "products": prods})

        if clean_path == "/api/products" and method == "POST":
            # Product Intake
            with get_db() as session:
                pid = body.get("id") or generate_uid("PRD")
                sku = body.get("sku") or generate_uid("ADN-GEN")
                barcode_id = body.get("barcode_id") or generate_uid("ADT")

                prod = Product(
                    id=pid,
                    sku=sku,
                    barcode_id=barcode_id,
                    name=body.get("name", "Untitled Piece"),
                    brand=body.get("brand", "Vintage"),
                    color=body.get("color", ""),
                    demographic=body.get("demographic", "Men"),
                    category=body.get("category", "Outerwear & Jackets"),
                    size=body.get("size", "-"),
                    condition=body.get("condition", "Grade A — Excellent"),
                    cost_price=int(body.get("cost_price", 0)),
                    selling_price=int(body.get("selling_price", 0)),
                    compare_price=int(body.get("compare_price", 0)),
                    in_stock_count=int(body.get("in_stock_count", 1)),
                    desc=body.get("desc", ""),
                    image_url=body.get("image_url", ""),
                    images=body.get("images", []),
                    rack_location=body.get("rack_location", "Rail A-1")
                )
                session.add(prod)

                # Create inventory log
                inv = Inventory(
                    id=generate_uid("INV"),
                    product_id=pid,
                    sku=sku,
                    rack_location=body.get("rack_location", "Rail A-1"),
                    quantity=int(body.get("in_stock_count", 1)),
                    batch_reference=body.get("batch_reference", "BATCH-INTAKE"),
                    intake_staff_id=body.get("staff_id", "STF-01"),
                    notes=body.get("notes", "New product intake")
                )
                session.add(inv)
                session.flush()
                return json_response({"status": "created", "product": prod.to_dict()}, status=201)

        if clean_path.startswith("/api/products/") and method == "GET":
            pid = clean_path.split("/")[-1]
            with get_db() as session:
                prod = session.query(Product).filter_by(id=pid).first()
                if not prod:
                    return json_response({"error": "Product not found"}, status=404)
                return json_response({"product": prod.to_dict()})

        # ----------------------------------------------------
        # 3. Categories API
        # ----------------------------------------------------
        if clean_path == "/api/categories" and method == "GET":
            with get_db() as session:
                cats = [c.to_dict() for c in session.query(Category).order_by(Category.sort_order.asc()).all()]
                return json_response({"categories": cats})

        # ----------------------------------------------------
        # 4. Orders & Checkouts (Web & POS)
        # ----------------------------------------------------
        if clean_path == "/api/orders" and method == "GET":
            with get_db() as session:
                q = session.query(Order)
                channel = query_params.get("channel", [""])[0]
                if channel:
                    q = q.filter(Order.channel == channel)
                orders = [o.to_dict() for o in q.order_by(Order.created_at.desc()).all()]
                return json_response({"count": len(orders), "orders": orders})

        if clean_path == "/api/orders" and method == "POST":
            # Atomic order placement & inventory reservation
            with get_db() as session:
                items_data = body.get("items", [])
                if not items_data:
                    return json_response({"error": "Order must contain at least one item"}, status=400)

                order_id = body.get("id") or f"AT-{int(datetime.utcnow().timestamp()) % 10000:04d}"
                channel = body.get("channel", "web")
                subtotal = 0
                order_items_objs = []

                for item in items_data:
                    pid = item.get("product_id") or item.get("id")
                    qty = int(item.get("qty", 1))

                    prod = session.query(Product).filter_by(id=pid).first()
                    if not prod:
                        return json_response({"error": f"Product {pid} not found"}, status=404)

                    # Atomic compare-and-swap inventory decrement
                    updated_rows = session.query(Product).filter(
                        Product.id == pid,
                        Product.in_stock_count >= qty
                    ).update(
                        {Product.in_stock_count: Product.in_stock_count - qty},
                        synchronize_session="fetch"
                    )

                    if updated_rows == 0:
                        return json_response({
                            "error": f"Product '{prod.name}' is out of stock or already reserved by another customer"
                        }, status=409)

                    unit_p = int(item.get("unit_price") or prod.selling_price)
                    line_tot = unit_p * qty
                    subtotal += line_tot

                    order_items_objs.append(OrderItem(
                        id=f"ITEM-{order_id}-{len(order_items_objs) + 1}",
                        order_id=order_id,
                        product_id=prod.id,
                        barcode_id=prod.barcode_id,
                        name=prod.name,
                        unit_price=unit_p,
                        qty=qty,
                        line_total=line_tot
                    ))

                delivery_fee = int(body.get("delivery_fee", 0))
                grand_total = subtotal + delivery_fee

                tender = body.get("tender") or {}
                cashier = body.get("cashier") or {}

                order = Order(
                    id=order_id,
                    channel=channel,
                    status=body.get("status", "completed"),
                    dispatch_status=body.get("dispatch_status", "Pending" if channel == "web" else "Delivered"),
                    customer_name=body.get("customer_name", "Walk-in Customer"),
                    customer_phone=body.get("customer_phone", ""),
                    customer_address=body.get("customer_address", ""),
                    delivery_type=body.get("delivery_type", "boda"),
                    delivery_area=body.get("delivery_area", ""),
                    delivery_fee=delivery_fee,
                    delivery_notes=body.get("delivery_notes", ""),
                    subtotal=subtotal,
                    total=grand_total,
                    tender_type=tender.get("type", "cash"),
                    tender_amount=tender.get("tendered"),
                    tender_change=tender.get("change"),
                    cashier_id=cashier.get("id"),
                    cashier_name=cashier.get("name"),
                    created_at=datetime.utcnow()
                )
                session.add(order)
                for oi in order_items_objs:
                    session.add(oi)

                # Record in ledger
                session.add(LedgerEntry(
                    id=generate_uid("LED"),
                    kind="sale",
                    amount=grand_total,
                    category="POS Sale" if channel == "pos" else "Online WhatsApp Sale",
                    description=f"Order {order_id} ({len(items_data)} items)",
                    staff_name=cashier.get("name", "System Checkout"),
                    ref_id=order_id,
                    created_at=datetime.utcnow()
                ))

                session.flush()
                return json_response({"status": "success", "order": order.to_dict()}, status=201)

        # ----------------------------------------------------
        # 5. Full-State Sync (Browser localStorage <-> PostgreSQL)
        # ----------------------------------------------------
        if clean_path == "/api/sync/pull" and method in ("GET", "POST"):
            with get_db() as session:
                products = [p.to_dict() for p in session.query(Product).order_by(Product.created_at.desc()).all()]
                categories = [c.to_dict() for c in session.query(Category).order_by(Category.sort_order.asc()).all()]
                orders = [o.to_dict() for o in session.query(Order).order_by(Order.created_at.desc()).all()]
                inventory = [i.to_dict() for i in session.query(Inventory).all()]
                riders = [r.to_dict() for r in session.query(Rider).all()]
                ledger = [l.to_dict() for l in session.query(LedgerEntry).order_by(LedgerEntry.created_at.desc()).all()]
                settings_rows = session.query(StoreSetting).all()
                settings = {s.key: s.value for s in settings_rows}

                return json_response({
                    "synced_at": datetime.utcnow().isoformat(),
                    "products": products,
                    "categories": categories,
                    "sales": orders,
                    "inventory": inventory,
                    "riders": riders,
                    "ledger": ledger,
                    "settings": settings
                })

        # ----------------------------------------------------
        # 6. Store Settings
        # ----------------------------------------------------
        if clean_path == "/api/settings" and method == "GET":
            with get_db() as session:
                rows = session.query(StoreSetting).all()
                data = {r.key: r.value for r in rows}
                return json_response({"settings": data})

        # ----------------------------------------------------
        # 7. Staff Authentication — server-side PIN verification
        #    Priority 1: ADMIN_ACCESS_PIN environment variable
        #                (the owner's emergency master PIN, set in
        #                 the Render dashboard — always grants admin)
        #    Priority 2: staff roster in the database (SHA-256 hashes)
        # ----------------------------------------------------
        if clean_path == "/api/auth/verify" and method == "POST":
            pin = str(body.get("pin") or "").strip()
            if not pin:
                return json_response({"ok": False, "error": "PIN required"}, status=400)

            env_pin = str(
                os.environ.get("ADMIN_ACCESS_PIN")
                or os.environ.get("STAFF_ACCESS_PIN")
                or ""
            ).strip()
            if env_pin and pin == env_pin:
                logger.info("[AUTH] Owner signed in with the environment master PIN")
                return json_response({
                    "ok": True,
                    "via": "env",
                    "staff": {"id": "ENV-ADMIN", "name": "Store Owner (Master PIN)", "role": "admin"}
                })

            pin_hash = hashlib.sha256(pin.encode("utf-8")).hexdigest()
            with get_db() as session:
                user = (
                    session.query(User)
                    .filter(User.active.is_(True), User.pin_hash == pin_hash)
                    .first()
                )
                if user:
                    logger.info("[AUTH] %s (%s) signed in via database PIN", user.name, user.role)
                    return json_response({
                        "ok": True,
                        "via": "db",
                        "staff": {"id": user.id, "name": user.name, "role": user.role}
                    })

            return json_response({"ok": False, "error": "Invalid PIN"}, status=401)

        return json_response({"error": "API route not found"}, status=404)

    except Exception as err:
        logger.error("[API Error] %s on %s %s", err, method, path, exc_info=True)
        return json_response({"error": "Internal Server Error", "details": str(err)}, status=500)
