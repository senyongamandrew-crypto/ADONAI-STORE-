"""
Adonai Thrift Store — SQLAlchemy ORM Data Models
Optimized for high-concurrency e-commerce queries, indexed searches, and PostgreSQL.
"""
from datetime import datetime
import json
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import relationship

from database import Base


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
    condition = Column(String(100), nullable=True)  # Grade A, Grade B, Vintage
    cost_price = Column(Integer, default=0)
    selling_price = Column(Integer, nullable=False, index=True)
    compare_price = Column(Integer, default=0)
    in_stock_count = Column(Integer, default=1, index=True)
    desc = Column(Text, nullable=True)
    image_url = Column(Text, nullable=True)
    images_json = Column(Text, default="[]")  # JSON string array of additional image angles
    rack_location = Column(String(50), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    inventory_items = relationship("Inventory", back_populates="product", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_product_search", "demographic", "category", "in_stock_count"),
        Index("idx_product_price_stock", "selling_price", "in_stock_count"),
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

    def to_dict(self):
        return {
            "id": self.id,
            "sku": self.sku,
            "barcode_id": self.barcode_id,
            "name": self.name,
            "brand": self.brand or "",
            "color": self.color or "",
            "demographic": self.demographic,
            "category": self.category,
            "size": self.size or "-",
            "condition": self.condition or "",
            "cost_price": self.cost_price,
            "selling_price": self.selling_price,
            "compare_price": self.compare_price,
            "in_stock_count": self.in_stock_count,
            "desc": self.desc or "",
            "image_url": self.image_url or "",
            "images": self.images,
            "rack_location": self.rack_location or "Rail A-1",
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None
        }


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
    status = Column(String(50), default="completed", index=True)  # 'completed', 'cancelled', 'held'
    dispatch_status = Column(String(50), default="Pending", index=True)  # 'Pending', 'Packed', 'With rider', 'Handed over', 'Delivered'
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
    tender_type = Column(String(50), default="cash")  # 'cash', 'mtn', 'airtel'
    tender_amount = Column(Integer, nullable=True)
    tender_change = Column(Integer, nullable=True)
    
    # Staff attribution
    cashier_id = Column(String(50), nullable=True)
    cashier_name = Column(String(100), nullable=True)
    rider_id = Column(String(50), nullable=True)
    rider_name = Column(String(100), nullable=True)
    
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
            "cashier": {
                "id": self.cashier_id,
                "name": self.cashier_name
            } if self.cashier_id or self.cashier_name else None,
            "rider": {
                "id": self.rider_id,
                "name": self.rider_name
            } if self.rider_id or self.rider_name else None,
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
    unit_price = Column(Integer, nullable=False)
    qty = Column(Integer, default=1)
    line_total = Column(Integer, nullable=False)

    order = relationship("Order", back_populates="items")

    def to_dict(self):
        return {
            "id": self.id,
            "product_id": self.product_id,
            "barcode_id": self.barcode_id or "",
            "name": self.name,
            "unit_price": self.unit_price,
            "qty": self.qty,
            "line_total": self.line_total
        }


class Rider(Base):
    __tablename__ = "riders"

    id = Column(String(50), primary_key=True)
    name = Column(String(100), nullable=False)
    phone = Column(String(50), nullable=False)
    status = Column(String(50), default="Available", index=True)  # Available, On delivery, Offline
    vehicle_plate = Column(String(50), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "phone": self.phone,
            "status": self.status,
            "plate": self.vehicle_plate or "",
            "created_at": self.created_at.isoformat() if self.created_at else None
        }


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
