"""
Adonai Store — Unified Retail SQLAlchemy ORM Data Models
Optimized for high-concurrency e-commerce queries, indexed searches, and PostgreSQL.
"""
from datetime import datetime
from enum import Enum as PyEnum
import json
import re
import unicodedata
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Numeric,
    Computed,
    Enum as SAEnum,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Float,
    String,
    Text,
    CheckConstraint,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship, deferred

from database import Base

# ============================================================================
# Product Detail Page (PDP) support helpers
# ============================================================================
# Flat-lay measurement keys accepted by the catalog. Thrift sizing varies by
# manufacturing standard and era, so the PDP never relies on the tagged size
# alone: every value below is stored in INCHES and converted to centimetres
# client-side.
MEASUREMENT_KEYS = (
    # Tops / jackets / dresses
    "shoulder", "chest", "sleeve", "length",
    # Pants / jeans / skirts
    "waist", "hip", "inseam", "rise", "thigh", "leg_opening",
    # Footwear
    "insole", "heel",
)

# Condition grades rendered as colour-coded badges on the storefront.
CONDITION_GRADES = (
    "Brand New with Tags (BNWT)",
    "Grade A — Excellent",
    "Grade B — Good",
    "Vintage / Collector",
)


def slugify(value: str, fallback: str = "piece") -> str:
    """Create a URL-safe, ASCII slug segment (used by /product/<slug>)."""
    text_value = unicodedata.normalize("NFKD", str(value or ""))
    text_value = text_value.encode("ascii", "ignore").decode("ascii").lower()
    text_value = re.sub(r"[^a-z0-9]+", "-", text_value).strip("-")
    text_value = re.sub(r"-{2,}", "-", text_value)
    return text_value or fallback


def build_product_slug(name: str, sku: str = "", product_id: str = "") -> str:
    """Stable, human-readable, collision-free product slug.

    `<item-name>-<sku>` — the SKU is already unique per piece, so the slug is
    unique too while staying readable and keyword-rich for SEO.
    """
    name_part = slugify(name, "thrift-piece")[:120].strip("-")
    tail = slugify(sku or product_id, "")[:40].strip("-")
    if tail and not name_part.endswith(tail):
        return f"{name_part}-{tail}".strip("-")
    return name_part or tail or "thrift-piece"


def normalize_measurements(raw) -> dict:
    """Coerce a measurements payload into a clean `{key: inches}` dict.

    Accepts a dict, a JSON string, or `None`. Unknown keys are preserved only
    when they are simple scalars so staff can record uncommon garment specs
    (e.g. "cuff") without a schema migration.
    """
    if raw is None or raw == "":
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return {}
    if not isinstance(raw, dict):
        return {}

    cleaned = {}
    for key, value in raw.items():
        key_name = slugify(key, "").replace("-", "_")[:40]
        if not key_name:
            continue
        if key_name == "notes":
            note = str(value or "").strip()[:400]
            if note:
                cleaned["notes"] = note
            continue
        try:
            inches = round(float(value), 2)
        except (TypeError, ValueError):
            continue
        if 0 < inches <= 120:
            cleaned[key_name] = inches
    return cleaned


class ItemCondition(str, PyEnum):
    """The two supported inventory streams in the unified catalog."""
    BRAND_NEW = "BRAND_NEW"
    PRE_LOVED = "PRE_LOVED"


class QuantityType(str, PyEnum):
    """Stock semantics used by both the web checkout and POS register."""
    BRAND_NEW = "BRAND_NEW"
    PRE_LOVED = "PRE_LOVED"


class User(Base):
    __tablename__ = "users"

    id = Column(String(50), primary_key=True)
    name = Column(String(100), nullable=False)
    role = Column(String(50), nullable=False, index=True)  # admin, manager, cashier, rider
    pin_hash = Column(String(255), nullable=True)
    active = Column(Boolean, default=True, index=True)
    phone = Column(String(50), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "active": self.active,
            "phone": self.phone or "",
            "created_at": self.created_at.isoformat() if self.created_at else None
        }


class Category(Base):
    __tablename__ = "categories"

    id = Column(String(50), primary_key=True)
    name = Column(String(100), unique=True, nullable=False, index=True)
    code = Column(String(10), unique=True, nullable=False)
    sort_order = Column(Integer, default=0, index=True)
    description = Column(Text, nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "code": self.code,
            "sort_order": self.sort_order,
            "description": self.description or ""
        }


class ConsignmentPartner(Base):
    """A supply partner whose catalog items are sold on consignment."""
    __tablename__ = "consignment_partners"

    id = Column(String(50), primary_key=True)
    name = Column(String(160), nullable=False, index=True)
    phone = Column(String(50), nullable=True)
    whatsapp = Column(String(50), nullable=True)
    email = Column(String(160), nullable=True)
    address = Column(Text, nullable=True)
    payout_provider = Column(String(60), nullable=True)
    payout_account_name = Column(String(120), nullable=True)
    payout_account = Column(String(100), nullable=True)
    default_commission_rate = Column(Numeric(5, 2), nullable=False, default=5.00)
    region = Column(String(100), nullable=True, index=True)
    supply_source = Column(String(120), nullable=True, index=True)
    notes = Column(Text, nullable=True)
    active = Column(Boolean, nullable=False, default=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    created_by_id = Column(String(50), nullable=True)
    created_by_name = Column(String(100), nullable=True)

    __table_args__ = (
        CheckConstraint("default_commission_rate >= 0 AND default_commission_rate <= 100", name="ck_consignment_partner_rate"),
    )

    products = relationship("Product", back_populates="consignment_partner")
    payouts = relationship("ConsignmentPayout", back_populates="partner")

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "phone": self.phone or "",
            "whatsapp": self.whatsapp or "",
            "email": self.email or "",
            "address": self.address or "",
            "payout_provider": self.payout_provider or "",
            "payout_account_name": self.payout_account_name or "",
            "payout_account": self.payout_account or "",
            "default_commission_rate": float(self.default_commission_rate or 0),
            "region": self.region or "",
            "supply_source": self.supply_source or "",
            "notes": self.notes or "",
            "active": bool(self.active),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "created_by_id": self.created_by_id or "",
            "created_by_name": self.created_by_name or "",
        }


class Product(Base):
    __tablename__ = "products"

    id = Column(String(50), primary_key=True)
    sku = Column(String(50), unique=True, nullable=False, index=True)
    barcode_id = Column(String(50), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=False, index=True)
    brand = Column(String(100), nullable=True, index=True)
    color = Column(String(50), nullable=True)
    demographic = Column(String(50), nullable=False, index=True)  # Men, Women, Children
    category = Column(String(100), nullable=False, index=True)
    size = Column(String(20), nullable=True)
    # `condition` remains the human-readable grade (for example Grade A).
    # `item_condition` is the inventory policy discriminator and is shared by
    # the storefront, POS, API, and PostgreSQL constraints.
    item_condition = Column(
        SAEnum(ItemCondition, name="item_condition_enum", native_enum=True,
               create_constraint=True, validate_strings=True),
        nullable=False,
        default=ItemCondition.BRAND_NEW,
        index=True,
    )
    quantity_type = Column(
        SAEnum(QuantityType, name="quantity_type_enum", native_enum=True,
               create_constraint=True, validate_strings=True),
        nullable=False,
        default=QuantityType.BRAND_NEW,
        index=True,
    )
    condition = Column(String(100), nullable=True)  # Grade A, Grade B, Collector
    size_variants_json = Column(Text, default="[]")
    color_variants_json = Column(Text, default="[]")
    factory_tag_notes = Column(Text, nullable=True)
    inner_packaging = Column(String(30), nullable=True)
    measurements_json = Column(Text, default="{}")
    fabric_grading_notes = Column(Text, nullable=True)
    cost_price = Column(Integer, default=0)
    # Canonical pricing inputs. The generated columns are also enforced in PostgreSQL;
    # selling_price remains the whole-UGX compatibility field used by the POS.
    base_price = Column(Numeric(14, 2), nullable=False, default=0)
    total_transport_cost = Column(Numeric(14, 2), nullable=False, default=0)
    embedded_transport_portion = Column(Numeric(14, 2), Computed("total_transport_cost * 0.50", persisted=True))
    checkout_transport_portion = Column(Numeric(14, 2), Computed("total_transport_cost * 0.50", persisted=True))
    final_selling_price = Column(Numeric(14, 2), Computed("base_price + (total_transport_cost * 0.50)", persisted=True))
    selling_price = Column(Integer, nullable=False, index=True)
    compare_price = Column(Integer, default=0)
    in_stock_count = Column(Integer, default=1, index=True)
    desc = Column(Text, nullable=True)
    image_url = Column(Text, nullable=True)
    images_json = Column(Text, default="[]")  # JSON string array of additional image angles
    rack_location = Column(String(50), nullable=True, index=True)
    # ---- Product Detail Page (PDP) fields --------------------------------
    # slug powers the shareable /product/<slug> permalink used by the
    # WhatsApp deep links and the sitemap.
    slug = Column(String(200), nullable=True, index=True)
    fabric = Column(String(255), nullable=True)          # e.g. "100% Cotton"
    measurements_json = Column(Text, default="{}")        # flat-lay specs, inches
    flaw_notes = Column(Text, nullable=True)              # mandatory disclosure copy
    flaw_photo_index = Column(Integer, default=-1)        # gallery index of the flaw close-up
    care_notes = Column(Text, nullable=True)              # washing / care instructions
    staff_notes = Column(Text, nullable=True)             # floor-staff + shopper note
    # Additive financial-ledger fields.  These are also installed safely by the
    # Render migration for databases that already contain the products table.
    stock_lot_id = Column(String(64), nullable=True, index=True)
    # Null ownership preserves the Source A store-owned inventory workflow.
    # Consignment pieces are always unique/pre-loved; a null item rate inherits
    # the partner's current default until a sale snapshots the applied rate.
    consignment_partner_id = Column(
        String(50), ForeignKey("consignment_partners.id", ondelete="RESTRICT", name="fk_products_consignment_partner"),
        nullable=True, index=True,
    )
    commission_rate = Column(Numeric(5, 2), nullable=True)
    # Grade tier inside the lot. When set, `cost_price` is the tier-locked unit
    # COGS — the server recomputes it from the lot's landed investment and the
    # tier's cost weight, so manual entry can never drift from the bale books.
    lot_grade_id = Column(String(64), nullable=True, index=True)
    inventory_status = Column(String(30), default="AVAILABLE", nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    inventory_items = relationship("Inventory", back_populates="product", cascade="all, delete-orphan")
    media_assets = relationship("ProductMedia", back_populates="product", cascade="all, delete-orphan", lazy="selectin")
    consignment_partner = relationship("ConsignmentPartner", back_populates="products")

    __table_args__ = (
        Index("idx_product_search", "demographic", "category", "in_stock_count"),
        Index("idx_product_price_stock", "selling_price", "in_stock_count"),
        CheckConstraint("commission_rate IS NULL OR (commission_rate >= 0 AND commission_rate <= 100)", name="ck_product_commission_rate"),
    )

    @property
    def images(self):
        try:
            return json.loads(self.images_json) if self.images_json else []
        except Exception:
            return []

    @images.setter
    def images(self, value):
        self.images_json = json.dumps(value if isinstance(value, list) else [])

    @property
    def size_variants(self):
        try:
            return json.loads(self.size_variants_json) if self.size_variants_json else []
        except Exception:
            return []

    @size_variants.setter
    def size_variants(self, value):
        self.size_variants_json = json.dumps(value if isinstance(value, list) else [])

    @property
    def color_variants(self):
        try:
            return json.loads(self.color_variants_json) if self.color_variants_json else []
        except Exception:
            return []

    @color_variants.setter
    def color_variants(self, value):
        self.color_variants_json = json.dumps(value if isinstance(value, list) else [])

    @property
    def measurements(self):
        return normalize_measurements(self.measurements_json)

    @measurements.setter
    def measurements(self, value):
        self.measurements_json = json.dumps(normalize_measurements(value))

    @property
    def public_slug(self):
        """Always return a usable permalink slug, even for legacy rows."""
        return self.slug or build_product_slug(self.name, self.sku, self.id)

    def to_dict(self):
        video = next((asset for asset in self.media_assets if asset.kind == "video"), None)
        return {
            "id": self.id,
            "sku": self.sku,
            "slug": self.public_slug,
            "barcode_id": self.barcode_id,
            "name": self.name,
            "brand": self.brand or "",
            "color": self.color or "",
            "demographic": self.demographic,
            "category": self.category,
            "size": self.size or "-",
            "condition": self.condition or "",
            "item_condition": self.item_condition.value if isinstance(self.item_condition, ItemCondition) else (self.item_condition or ItemCondition.PRE_LOVED.value),
            "quantity_type": self.quantity_type.value if isinstance(self.quantity_type, QuantityType) else (self.quantity_type or QuantityType.PRE_LOVED.value),
            "size_variants": self.size_variants,
            "color_variants": self.color_variants,
            "factory_tag_notes": self.factory_tag_notes or "",
            "inner_packaging": self.inner_packaging or "",
            "measurements": self.measurements,
            "fabric_grading_notes": self.fabric_grading_notes or "",
            "is_one_of_one": (self.item_condition.value if isinstance(self.item_condition, ItemCondition) else self.item_condition) == ItemCondition.PRE_LOVED.value,
            "cost_price": self.cost_price,
            "base_price": float(self.base_price or 0),
            "total_transport_cost": float(self.total_transport_cost or 0),
            "embedded_transport_portion": float(self.embedded_transport_portion if self.embedded_transport_portion is not None else (self.total_transport_cost or 0) * 0.5),
            "checkout_transport_portion": float(self.checkout_transport_portion if self.checkout_transport_portion is not None else (self.total_transport_cost or 0) * 0.5),
            # Defensive: never advertise UGX 0 to a shopper if the generated
            # column is empty on a legacy row — fall back to selling_price.
            "final_selling_price": float(
                self.final_selling_price
                if self.final_selling_price not in (None, 0)
                else (self.selling_price or 0)
            ),
            "selling_price": self.selling_price,
            "compare_price": self.compare_price,
            "in_stock_count": self.in_stock_count,
            "desc": self.desc or "",
            "image_url": self.image_url or "",
            "images": self.images,
            "video": video.to_dict() if video else None,
            "fabric": self.fabric or "",
            "measurements": self.measurements,
            "flaw_notes": self.flaw_notes or "",
            "flaw_photo_index": self.flaw_photo_index if self.flaw_photo_index is not None else -1,
            "care_notes": self.care_notes or "",
            "staff_notes": self.staff_notes or "",
            "rack_location": self.rack_location or "Rail A-1",
            "stock_lot_id": self.stock_lot_id or "",
            "lot_grade_id": self.lot_grade_id or "",
            "inventory_status": self.inventory_status or "AVAILABLE",
            "is_consignment": bool(self.consignment_partner_id),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None
        }


class ExportDownload(Base):
    """Short-lived authorized download capabilities, shared across workers."""
    __tablename__ = "export_downloads"
    token_hash = Column(String(64), primary_key=True)
    filename = Column(String(180), nullable=False)
    mime_type = Column(String(100), nullable=False)
    kind = Column(String(30), nullable=False)
    record_count = Column(Integer, nullable=False)
    byte_length = Column(Integer, nullable=False)
    data = deferred(Column(LargeBinary, nullable=False))
    token_hashes_json = Column(Text, nullable=False, default="[]")
    staff_id = Column(String(64), nullable=False)
    requires_staff_auth = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False, index=True)


class ProductMedia(Base):
    """Durable binary media; catalog queries load metadata, never the bytes."""
    __tablename__ = "product_media"
    id = Column(String(32), primary_key=True)
    product_id = Column(String(50), ForeignKey("products.id", ondelete="CASCADE"), nullable=True, index=True)
    kind = Column(String(10), nullable=False)
    mime_type = Column(String(40), nullable=False)
    filename = Column(String(160), nullable=False)
    byte_length = Column(Integer, nullable=False)
    width = Column(Integer, nullable=False)
    height = Column(Integer, nullable=False)
    duration = Column(Float, nullable=True)
    data = deferred(Column(LargeBinary, nullable=False))
    uploaded_by = Column(String(64), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    product = relationship("Product", back_populates="media_assets")
    __table_args__ = (CheckConstraint("kind IN ('image', 'video')", name="ck_product_media_kind"),)

    def to_dict(self):
        return {"id": self.id, "url": "/api/media/" + self.id, "type": self.mime_type,
                "name": self.filename, "bytes": self.byte_length, "width": self.width,
                "height": self.height, "duration": self.duration}


class Inventory(Base):
    __tablename__ = "inventory"

    id = Column(String(50), primary_key=True)
    product_id = Column(String(50), ForeignKey("products.id", ondelete="CASCADE"), nullable=False, index=True)
    sku = Column(String(50), nullable=False, index=True)
    rack_location = Column(String(50), nullable=False, index=True)
    quantity = Column(Integer, default=1)
    batch_reference = Column(String(100), nullable=True)
    intake_date = Column(DateTime, default=datetime.utcnow, index=True)
    intake_staff_id = Column(String(50), nullable=True)
    notes = Column(Text, nullable=True)

    product = relationship("Product", back_populates="inventory_items")

    def to_dict(self):
        return {
            "id": self.id,
            "product_id": self.product_id,
            "sku": self.sku,
            "rack_location": self.rack_location,
            "quantity": self.quantity,
            "batch_reference": self.batch_reference or "",
            "intake_date": self.intake_date.isoformat() if self.intake_date else None,
            "intake_staff_id": self.intake_staff_id or "",
            "notes": self.notes or ""
        }


class Order(Base):
    __tablename__ = "orders"

    id = Column(String(50), primary_key=True)  # AT-1841, etc.
    channel = Column(String(50), default="web", index=True)  # 'web' or 'pos'
    status = Column(String(50), default="unfulfilled", index=True)  # unfulfilled, processing, completed, cancelled
    dispatch_status = Column(String(50), default="Unfulfilled", index=True)  # Unfulfilled → In Assembly → Ready for Pickup/Dispatched → Completed
    customer_name = Column(String(255), nullable=True, index=True)
    customer_phone = Column(String(50), nullable=True, index=True)
    customer_address = Column(Text, nullable=True)
    delivery_type = Column(String(50), default="boda")  # 'boda' or 'pickup'
    delivery_area = Column(String(100), nullable=True)
    delivery_fee = Column(Integer, default=0)
    delivery_notes = Column(Text, nullable=True)
    subtotal = Column(Integer, nullable=False)
    total = Column(Integer, nullable=False)
    
    # Tender / Payment details
    tender_type = Column(String(50), default="cash")  # 'cash', 'mtn', 'airtel', 'flutterwave'
    tender_amount = Column(Integer, nullable=True)
    tender_change = Column(Integer, nullable=True)

    # Online gateway payment lifecycle (Flutterwave). Web orders paid online
    # start 'pending' and only become 'paid' after server-side verification.
    payment_status = Column(String(20), default="unpaid", index=True)  # 'unpaid', 'pending', 'paid', 'failed'
    payment_provider = Column(String(30), nullable=True)  # 'flutterwave', etc.
    payment_reference = Column(String(100), nullable=True, index=True)  # latest gateway tx_ref
    payment_token_hash = Column(String(128), nullable=True)  # sha256 of the per-order payment token
    paid_at = Column(DateTime, nullable=True)
    payment_expires_at = Column(DateTime, nullable=True, index=True)  # stock released when this lapses unpaid

    # Staff attribution
    cashier_id = Column(String(50), nullable=True)
    cashier_name = Column(String(100), nullable=True)
    rider_id = Column(String(50), nullable=True)
    rider_name = Column(String(100), nullable=True)

    # When the order first left assembly for dispatch (day boundary for the Orders list)
    # and when staff removed it from the active list. Records keep every order either way.
    dispatched_at = Column(DateTime, nullable=True)
    list_archived_at = Column(DateTime, nullable=True)
    
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    items = relationship("OrderItem", back_populates="order", cascade="all, delete-orphan")

    def to_dict(self):
        return {
            "id": self.id,
            "channel": self.channel,
            "status": self.status,
            "dispatch_status": self.dispatch_status,
            "customer_name": self.customer_name or "",
            "customer_phone": self.customer_phone or "",
            "customer_address": self.customer_address or "",
            "delivery_type": self.delivery_type,
            "delivery_area": self.delivery_area or "",
            "delivery_fee": self.delivery_fee,
            "delivery_notes": self.delivery_notes or "",
            "subtotal": self.subtotal,
            "total": self.total,
            "tender": {
                "type": self.tender_type or "cash",
                "tendered": self.tender_amount,
                "change": self.tender_change
            } if self.tender_type else None,
            "payment": {
                "status": self.payment_status or "unpaid",
                "provider": self.payment_provider or "",
                "reference": self.payment_reference or "",
                "paid_at": self.paid_at.isoformat() if self.paid_at else None,
                "expires_at": self.payment_expires_at.isoformat() if self.payment_expires_at else None,
            },
            "cashier": {
                "id": self.cashier_id,
                "name": self.cashier_name
            } if self.cashier_id or self.cashier_name else None,
            # Keep the structured rider object for API clients while exposing
            # the flat aliases consumed by the operations console. Without
            # these aliases, dispatch succeeded on the server but the assigned
            # rider disappeared when the order was reloaded.
            "rider": {
                "id": self.rider_id,
                "name": self.rider_name
            } if self.rider_id or self.rider_name else None,
            "assigned_rider_id": self.rider_id or None,
            "assigned_rider_name": self.rider_name or None,
            "dispatched_at": self.dispatched_at.isoformat() if self.dispatched_at else None,
            "list_archived_at": self.list_archived_at.isoformat() if self.list_archived_at else None,
            "items": [it.to_dict() for it in self.items],
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None
        }


class OrderItem(Base):
    __tablename__ = "order_items"

    id = Column(String(50), primary_key=True)
    order_id = Column(String(50), ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True)
    product_id = Column(String(50), nullable=True, index=True)
    barcode_id = Column(String(50), nullable=True)
    name = Column(String(255), nullable=False)
    item_condition = Column(String(20), nullable=False, default=ItemCondition.BRAND_NEW.value)
    quantity_type = Column(String(20), nullable=False, default=QuantityType.BRAND_NEW.value)
    unit_price = Column(Integer, nullable=False)
    # Snapshots preserve historical COGS/category/policy even when the product changes.
    unit_cost = Column(Integer, default=0, nullable=False)
    category = Column(String(100), nullable=True, index=True)
    qty = Column(Integer, default=1)
    line_total = Column(Integer, nullable=False)
    # Immutable sale-time snapshots: partner edits and catalog repricing never
    # change what the store earned or owes for an earlier order.
    consignment_partner_id = Column(
        String(50), ForeignKey("consignment_partners.id", ondelete="SET NULL", name="fk_order_items_consignment_partner"), nullable=True, index=True
    )
    partner_name_snapshot = Column(String(160), nullable=True)
    commission_rate_snapshot = Column(Numeric(5, 2), nullable=True)
    consignment_gross_amount = Column(Integer, nullable=False, default=0)
    consignment_commission_amount = Column(Integer, nullable=False, default=0)
    partner_payable_amount = Column(Integer, nullable=False, default=0)

    order = relationship("Order", back_populates="items")

    def to_dict(self):
        return {
            "id": self.id,
            "product_id": self.product_id,
            "barcode_id": self.barcode_id or "",
            "name": self.name,
            "item_condition": self.item_condition or ItemCondition.PRE_LOVED.value,
            "quantity_type": self.quantity_type or QuantityType.PRE_LOVED.value,
            "unit_price": self.unit_price,
            "unit_cost": self.unit_cost or 0,
            "category": self.category or "Uncategorised",
            "qty": self.qty,
            "line_total": self.line_total,
            "is_consignment": bool(self.consignment_partner_id),
            "consignment_partner_id": self.consignment_partner_id or "",
            "partner_name_snapshot": self.partner_name_snapshot or "",
            "commission_rate_snapshot": float(self.commission_rate_snapshot) if self.commission_rate_snapshot is not None else None,
            "consignment_gross_amount": int(self.consignment_gross_amount or 0),
            "consignment_commission_amount": int(self.consignment_commission_amount or 0),
            "partner_payable_amount": int(self.partner_payable_amount or 0),
        }


class PaymentTransaction(Base):
    """
    One row per online payment ATTEMPT (a fresh gateway tx_ref each time).
    This is the idempotency backbone of the payment flow: both the browser
    verify call and the server-to-server webhook settle through these rows,
    and each attempt is marked successful exactly once.
    """
    __tablename__ = "payment_transactions"

    id = Column(String(50), primary_key=True)  # PAY-..., internal id
    tx_ref = Column(String(100), unique=True, nullable=False, index=True)  # gateway reference for the attempt
    order_id = Column(String(50), ForeignKey("orders.id", ondelete="CASCADE"), nullable=False, index=True)
    provider = Column(String(30), default="flutterwave", nullable=False)
    flw_transaction_id = Column(String(40), nullable=True, index=True)  # numeric gateway transaction id
    amount = Column(Integer, nullable=False, default=0)  # expected amount (server-side order total)
    currency = Column(String(10), default="UGX", nullable=False)
    status = Column(String(20), default="pending", nullable=False, index=True)  # 'pending', 'successful', 'failed'
    channel = Column(String(40), nullable=True)  # 'mobilemoneyuganda', 'card', ...
    gateway_payload = Column(Text, nullable=True)  # compact verify-response audit snapshot
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    order = relationship("Order")

    def to_dict(self):
        return {
            "id": self.id,
            "tx_ref": self.tx_ref,
            "order_id": self.order_id,
            "provider": self.provider,
            "flw_transaction_id": self.flw_transaction_id or "",
            "amount": self.amount,
            "currency": self.currency,
            "status": self.status,
            "channel": self.channel or "",
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class Rider(Base):
    __tablename__ = "riders"

    id = Column(String(50), primary_key=True)
    name = Column(String(100), nullable=False)
    phone = Column(String(50), nullable=False)
    status = Column(String(50), default="Available", index=True)  # Available, On delivery, Offline
    vehicle_plate = Column(String(50), nullable=True)
    vehicle = Column(String(100), default="Motorbike (Boda)")
    zone = Column(String(100), default="")
    archived = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "phone": self.phone,
            "status": self.status,
            "plate": self.vehicle_plate or "",
            "vehicle": self.vehicle or "Motorbike (Boda)",
            "zone": self.zone or "",
            "archived": bool(self.archived),
            "created_at": self.created_at.isoformat() if self.created_at else None
        }


class RiderDevice(Base):
    """One paired phone per rider. Secrets are hashed; only the latest GPS fix."""
    __tablename__ = "rider_devices"
    id = Column(String(64), primary_key=True)
    rider_id = Column(String(50), ForeignKey("riders.id"), nullable=False, unique=True)
    label = Column(String(100), nullable=False)
    token_hash = Column(String(64), nullable=False, unique=True)
    expires_at = Column(DateTime, nullable=False)
    revoked = Column(Boolean, nullable=False, default=False)
    sharing = Column(Boolean, nullable=False, default=False)
    duty_until = Column(DateTime, nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    accuracy = Column(Float, nullable=True)
    fix_at = Column(DateTime, nullable=True)
    received_at = Column(DateTime, nullable=True)
    mock_location = Column(Boolean, nullable=False, default=False)
    sequence = Column(Integer, nullable=False, default=0)
    paired_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class RiderPairing(Base):
    __tablename__ = "rider_pairings"
    rider_id = Column(String(50), ForeignKey("riders.id"), primary_key=True)
    code_hash = Column(String(64), nullable=False, unique=True)
    expires_at = Column(DateTime, nullable=False)
    issued_by = Column(String(100), nullable=True)


class DeliveryEvent(Base):
    """Delivery accountability, without keeping a rider's route/location trail."""
    __tablename__ = "delivery_events"
    id = Column(String(64), primary_key=True)
    order_id = Column(String(50), ForeignKey("orders.id"), nullable=False, index=True)
    rider_id = Column(String(50), ForeignKey("riders.id"), nullable=False, index=True)
    device_id = Column(String(64), nullable=True)
    stage = Column(String(30), nullable=False)
    note = Column(String(500), nullable=True)
    received_by = Column(String(100), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class LedgerEntry(Base):
    __tablename__ = "ledger_entries"

    id = Column(String(50), primary_key=True)
    kind = Column(String(50), nullable=False, index=True)  # sale, expense, refund, adjustment
    amount = Column(Integer, nullable=False)
    category = Column(String(100), nullable=True)
    description = Column(Text, nullable=True)
    staff_name = Column(String(100), nullable=True)
    ref_id = Column(String(50), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "kind": self.kind,
            "amount": self.amount,
            "category": self.category or "",
            "desc": self.description or "",
            "staff": self.staff_name or "",
            "ref_id": self.ref_id or "",
            "created_at": self.created_at.isoformat() if self.created_at else None
        }


# ---------------------------------------------------------------------------
# Additive accounting and stock-control schema
# ---------------------------------------------------------------------------

class AccountingJournalEntry(Base):
    """Immutable journal header. Reversals are posted as separate entries."""
    __tablename__ = "accounting_journal_entries"

    id = Column(String(64), primary_key=True)
    reference = Column(String(100), nullable=False, index=True)
    source = Column(String(50), nullable=False, index=True)
    description = Column(Text, nullable=True)
    status = Column(String(20), default="POSTED", nullable=False, index=True)
    occurred_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    created_by_id = Column(String(50), nullable=True)
    created_by_name = Column(String(100), nullable=True)
    reversal_of_id = Column(String(64), nullable=True, index=True)

    lines = relationship(
        "AccountingJournalLine", back_populates="entry", cascade="all, delete-orphan"
    )

    def to_dict(self, include_lines=False):
        data = {
            "id": self.id,
            "reference": self.reference,
            "source": self.source,
            "description": self.description or "",
            "status": self.status,
            "occurred_at": self.occurred_at.isoformat() + "Z" if self.occurred_at else None,
            "created_at": self.created_at.isoformat() + "Z" if self.created_at else None,
            "created_by_id": self.created_by_id or "",
            "created_by_name": self.created_by_name or "",
            "reversal_of_id": self.reversal_of_id or "",
        }
        if include_lines:
            data["lines"] = [line.to_dict() for line in self.lines]
        return data


class AccountingJournalLine(Base):
    __tablename__ = "accounting_journal_lines"

    id = Column(String(64), primary_key=True)
    journal_entry_id = Column(
        String(64),
        ForeignKey("accounting_journal_entries.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    account_code = Column(String(20), nullable=False, index=True)
    account_name = Column(String(120), nullable=False, index=True)
    debit = Column(Integer, default=0, nullable=False)
    credit = Column(Integer, default=0, nullable=False)
    memo = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    entry = relationship("AccountingJournalEntry", back_populates="lines")

    __table_args__ = (
        CheckConstraint("debit >= 0", name="ck_journal_line_debit_nonnegative"),
        CheckConstraint("credit >= 0", name="ck_journal_line_credit_nonnegative"),
        CheckConstraint(
            "(debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)",
            name="ck_journal_line_one_side",
        ),
        Index("idx_journal_line_account_entry", "account_code", "journal_entry_id"),
    )

    def to_dict(self):
        return {
            "id": self.id,
            "journal_entry_id": self.journal_entry_id,
            "account_code": self.account_code,
            "account_name": self.account_name,
            "debit": self.debit,
            "credit": self.credit,
            "memo": self.memo or "",
        }


class ConsignmentPayout(Base):
    """Immutable partner settlement; every payout also has a journal entry."""
    __tablename__ = "consignment_payouts"

    id = Column(String(64), primary_key=True)
    partner_id = Column(String(50), ForeignKey("consignment_partners.id", ondelete="RESTRICT"), nullable=False, index=True)
    amount = Column(Integer, nullable=False)
    payment_method = Column(String(30), nullable=False)
    destination_snapshot = Column(String(180), nullable=True)
    reference = Column(String(120), nullable=True)
    notes = Column(Text, nullable=True)
    idempotency_key = Column(String(120), nullable=False, unique=True)
    journal_entry_id = Column(String(64), ForeignKey("accounting_journal_entries.id", ondelete="RESTRICT"), nullable=False, unique=True)
    created_by_id = Column(String(50), nullable=True)
    created_by_name = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    __table_args__ = (CheckConstraint("amount > 0", name="ck_consignment_payout_amount"),)

    partner = relationship("ConsignmentPartner", back_populates="payouts")
    journal_entry = relationship("AccountingJournalEntry")

    def to_dict(self):
        return {
            "id": self.id,
            "partner_id": self.partner_id,
            "amount": int(self.amount or 0),
            "payment_method": self.payment_method or "cash",
            "destination_snapshot": self.destination_snapshot or "",
            "reference": self.reference or "",
            "notes": self.notes or "",
            "journal_entry_id": self.journal_entry_id,
            "created_by_id": self.created_by_id or "",
            "created_by_name": self.created_by_name or "",
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class ExpenseRecord(Base):
    __tablename__ = "financial_expenses"

    id = Column(String(64), primary_key=True)
    category = Column(String(100), nullable=False, index=True)
    amount = Column(Integer, nullable=False)
    payment_method = Column(String(50), nullable=False, index=True)
    vendor = Column(String(150), nullable=True, index=True)
    receipt_reference = Column(String(120), nullable=True, index=True)
    notes = Column(Text, nullable=True)
    status = Column(String(20), default="POSTED", nullable=False, index=True)
    occurred_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    journal_entry_id = Column(String(64), nullable=True, index=True)
    created_by_id = Column(String(50), nullable=True)
    created_by_name = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    voided_at = Column(DateTime, nullable=True)
    voided_by_id = Column(String(50), nullable=True)
    void_reason = Column(Text, nullable=True)

    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_financial_expense_positive"),
    )

    def to_dict(self):
        return {
            "id": self.id,
            "category": self.category,
            "amount": self.amount,
            "payment_method": self.payment_method,
            "vendor": self.vendor or "",
            "receipt_reference": self.receipt_reference or "",
            "notes": self.notes or "",
            "status": self.status,
            "occurred_at": self.occurred_at.isoformat() + "Z" if self.occurred_at else None,
            "journal_entry_id": self.journal_entry_id or "",
            "created_by_id": self.created_by_id or "",
            "created_by_name": self.created_by_name or "",
            "created_at": self.created_at.isoformat() + "Z" if self.created_at else None,
            "voided_at": self.voided_at.isoformat() + "Z" if self.voided_at else None,
            "void_reason": self.void_reason or "",
        }


class StockLot(Base):
    __tablename__ = "financial_stock_lots"

    id = Column(String(64), primary_key=True)
    lot_code = Column(String(50), unique=True, nullable=False, index=True)
    supplier = Column(String(150), nullable=False, index=True)
    description = Column(Text, nullable=False)
    acquisition_cost = Column(Integer, nullable=False)
    shipping_cost = Column(Integer, default=0, nullable=False)
    total_landed_cost = Column(Integer, nullable=False)
    item_count = Column(Integer, nullable=False)
    unit_cost = Column(Integer, nullable=False)
    payment_method = Column(String(50), default="cash", nullable=False)
    status = Column(String(30), default="OPEN", nullable=False, index=True)
    allocated_count = Column(Integer, default=0, nullable=False)
    acquired_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    journal_entry_id = Column(String(64), nullable=True, index=True)
    created_by_id = Column(String(50), nullable=True)
    created_by_name = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    grades = relationship(
        "LotGrade",
        back_populates="lot",
        cascade="all, delete-orphan",
        order_by="LotGrade.sort_order",
    )

    __table_args__ = (
        CheckConstraint("acquisition_cost >= 0", name="ck_stock_lot_acquisition_nonnegative"),
        CheckConstraint("shipping_cost >= 0", name="ck_stock_lot_shipping_nonnegative"),
        CheckConstraint("item_count > 0", name="ck_stock_lot_items_positive"),
    )

    def to_dict(self, include_grades: bool = False):
        data = {
            "id": self.id,
            "lot_code": self.lot_code,
            "supplier": self.supplier,
            "description": self.description,
            "acquisition_cost": self.acquisition_cost,
            "shipping_cost": self.shipping_cost,
            "total_landed_cost": self.total_landed_cost,
            "item_count": self.item_count,
            "unit_cost": self.unit_cost,
            "payment_method": self.payment_method,
            "status": self.status,
            "allocated_count": self.allocated_count,
            "remaining_count": max(0, self.item_count - self.allocated_count),
            "acquired_at": self.acquired_at.isoformat() + "Z" if self.acquired_at else None,
            "journal_entry_id": self.journal_entry_id or "",
            "created_by_name": self.created_by_name or "",
        }
        if include_grades:
            data["grades"] = [grade.to_dict() for grade in (self.grades or [])]
        return data


class LotGrade(Base):
    """One cost tier inside a stock lot (multi-tier in-batch grading).

    The parent lot books the landed investment once; each tier receives a
    weighted share of it, so a mixed bale (Premium / Standard / Clearance
    pieces) prices every tag from an accurate, LOCKED unit COGS. The API
    recomputes `unit_cogs` at registration and refuses weights that do not
    total 100% — the client table is a preview, never the source of truth.
    """
    __tablename__ = "financial_lot_grades"

    id = Column(String(64), primary_key=True)
    lot_id = Column(
        String(64),
        ForeignKey("financial_stock_lots.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    sort_order = Column(Integer, default=0, nullable=False)
    grade_name = Column(String(100), nullable=False)
    expected_count = Column(Integer, nullable=False)
    cost_weight_percentage = Column(Numeric(6, 3), nullable=False)
    unit_cogs = Column(Integer, nullable=False)  # server-computed, locked
    target_selling_price = Column(Integer, nullable=False, default=0)
    allocated_count = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    lot = relationship("StockLot", back_populates="grades")

    __table_args__ = (
        CheckConstraint("expected_count > 0", name="ck_lot_grade_items_positive"),
        CheckConstraint(
            "cost_weight_percentage > 0 AND cost_weight_percentage <= 100",
            name="ck_lot_grade_weight_range",
        ),
        CheckConstraint("unit_cogs >= 0", name="ck_lot_grade_cogs_nonnegative"),
        CheckConstraint("allocated_count >= 0", name="ck_lot_grade_allocated_nonnegative"),
        Index("idx_lot_grade_lot_sort", "lot_id", "sort_order"),
    )

    @property
    def remaining_count(self) -> int:
        return max(0, int(self.expected_count or 0) - int(self.allocated_count or 0))

    def to_dict(self):
        return {
            "id": self.id,
            "lot_id": self.lot_id,
            "sort_order": self.sort_order,
            "grade_name": self.grade_name,
            "expected_count": self.expected_count,
            "cost_weight_percentage": float(self.cost_weight_percentage or 0),
            "unit_cogs": self.unit_cogs,
            "target_selling_price": self.target_selling_price,
            "allocated_count": self.allocated_count,
            "remaining_count": self.remaining_count,
            "created_at": self.created_at.isoformat() + "Z" if self.created_at else None,
        }


class InventoryAdjustment(Base):
    __tablename__ = "financial_inventory_adjustments"

    id = Column(String(64), primary_key=True)
    product_id = Column(String(50), nullable=False, index=True)
    adjustment_type = Column(String(30), nullable=False, index=True)
    quantity = Column(Integer, default=0, nullable=False)
    old_price = Column(Integer, nullable=True)
    new_price = Column(Integer, nullable=True)
    loss_amount = Column(Integer, default=0, nullable=False)
    reason = Column(Text, nullable=True)
    journal_entry_id = Column(String(64), nullable=True, index=True)
    created_by_id = Column(String(50), nullable=True)
    created_by_name = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "product_id": self.product_id,
            "adjustment_type": self.adjustment_type,
            "quantity": self.quantity,
            "old_price": self.old_price,
            "new_price": self.new_price,
            "loss_amount": self.loss_amount,
            "reason": self.reason or "",
            "journal_entry_id": self.journal_entry_id or "",
            "created_by_name": self.created_by_name or "",
            "created_at": self.created_at.isoformat() + "Z" if self.created_at else None,
        }


class InventoryLock(Base):
    __tablename__ = "pos_inventory_locks"

    id = Column(String(64), primary_key=True)
    product_id = Column(String(50), nullable=False, index=True)
    lock_owner = Column(String(100), nullable=False, index=True)
    quantity = Column(Integer, default=1, nullable=False)
    expires_at = Column(DateTime, nullable=False, index=True)
    created_by_id = Column(String(50), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("product_id", "lock_owner", name="uq_pos_lock_product_owner"),
        CheckConstraint("quantity > 0", name="ck_pos_inventory_lock_positive"),
        Index("idx_pos_lock_product_expiry", "product_id", "expires_at"),
    )

    def to_dict(self):
        return {
            "id": self.id,
            "product_id": self.product_id,
            "lock_owner": self.lock_owner,
            "quantity": self.quantity,
            "expires_at": self.expires_at.isoformat() + "Z" if self.expires_at else None,
        }


class StoreSetting(Base):
    __tablename__ = "settings"

    key = Column(String(100), primary_key=True)
    value = Column(Text, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            "key": self.key,
            "value": self.value,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None
        }


class PosAccessKey(Base):
    """Owner-configured passwords for selected POS workspaces (never plaintext)."""
    __tablename__ = "pos_access_keys"

    id = Column(String(64), primary_key=True)
    name = Column(String(80), nullable=False)
    password_hash = Column(String(255), nullable=False)
    areas = Column(Text, nullable=False, default="[]")
    is_admin = Column(Boolean, nullable=False, default=False)
    enabled = Column(Boolean, nullable=False, default=True)
    version = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def to_public(self):
        return {
            "id": self.id, "name": self.name, "areas": json.loads(self.areas),
            "is_admin": self.is_admin, "enabled": self.enabled,
            "created_at": self.created_at.isoformat() + "Z" if self.created_at else None,
            "updated_at": self.updated_at.isoformat() + "Z" if self.updated_at else None,
        }


class PosAccessSession(Base):
    """Database-backed, revocable sessions shared by all server workers."""
    __tablename__ = "pos_access_sessions"

    token_hash = Column(String(64), primary_key=True)
    key_id = Column(String(64), ForeignKey("pos_access_keys.id", ondelete="CASCADE"), nullable=False, index=True)
    key_version = Column(Integer, nullable=False)
    expires_at = Column(DateTime, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class NotificationEvent(Base):
    """Committed store activity shared by all workers and retained on restart."""
    __tablename__ = "notification_events"

    id = Column(String(64), primary_key=True)
    event_type = Column(String(40), nullable=False)
    title = Column(String(255), nullable=False)
    message = Column(Text, nullable=False)
    payload_json = Column(Text, nullable=False, default="{}")
    source_key = Column(String(160), nullable=True, unique=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    __table_args__ = (Index("idx_notification_history", "created_at", "id"),)

    def to_dict(self):
        from datetime import timezone
        return {
            "id": self.id, "type": self.event_type, "title": self.title,
            "message": self.message, "payload": json.loads(self.payload_json),
            "timestamp": self.created_at.replace(tzinfo=timezone.utc).timestamp(),
        }


class NotificationStreamTicket(Base):
    """Hashed, atomic one-use SSE handshakes; not tied to a server worker."""
    __tablename__ = "notification_stream_tickets"

    ticket_hash = Column(String(64), primary_key=True)
    staff_json = Column(Text, nullable=False)
    expires_at = Column(DateTime, nullable=False, index=True)
