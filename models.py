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
    CheckConstraint,
    UniqueConstraint,
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
    # Additive financial-ledger fields.  These are also installed safely by the
    # Render migration for databases that already contain the products table.
    stock_lot_id = Column(String(64), nullable=True, index=True)
    inventory_status = Column(String(30), default="AVAILABLE", nullable=False, index=True)
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
            "stock_lot_id": self.stock_lot_id or "",
            "inventory_status": self.inventory_status or "AVAILABLE",
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
    # Snapshots preserve historical COGS/category even when the product changes.
    unit_cost = Column(Integer, default=0, nullable=False)
    category = Column(String(100), nullable=True, index=True)
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
            "unit_cost": self.unit_cost or 0,
            "category": self.category or "Uncategorised",
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

    __table_args__ = (
        CheckConstraint("acquisition_cost >= 0", name="ck_stock_lot_acquisition_nonnegative"),
        CheckConstraint("shipping_cost >= 0", name="ck_stock_lot_shipping_nonnegative"),
        CheckConstraint("item_count > 0", name="ck_stock_lot_items_positive"),
    )

    def to_dict(self):
        return {
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
