#!/usr/bin/env python3
"""Seed a self-contained demo dataset for exploring the Adonai rider delivery flow.

DEMO FIXTURES ONLY — all data lives in the local SQLite file (adonai.db) and can
be removed by deleting that file. Nothing here is written to any live store.

Creates:
  * owner admin password + an "orders" area password (the privacy gate that must
    be on before phone pairing / GPS viewing is allowed)
  * one delivery partner (rider) with a live single-use pairing code
  * two paid web delivery orders — one already dispatched to the rider, one left
    "In Assembly" so it can be assigned from the dispatch console

Usage:
  .venv/bin/python scripts/demo_seed.py
"""
import json
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db_init import init_db
from database import get_db
from security import hash_pin
from models import (
    Order, OrderItem, Product, Rider, RiderDevice, RiderPairing, PosAccessKey,
)
import access_control
import dispatch

# ---- demo credentials (printed at the end) ---------------------------------
ADMIN_PASSWORD = "adonai-admin-1"
ORDERS_PASSWORD = "adonai-demo-1"       # unlocks Orders, dispatch & audit + GPS board
PAIRING_CODE = "DEMORIDERS"             # [A-Z2-7]{10} single-use phone pairing code

RID = "RDP-DEMO01"


def now():
    return datetime.utcnow()


def seed():
    init_db()
    with get_db() as s:
        # 1) Protect the orders/dispatch area (required before pairing is allowed)
        access_control._set_protected(s, {"orders"})

        # 2) Owner admin password + orders-area password
        owner = s.get(PosAccessKey, access_control.OWNER_ID)
        if not owner:
            owner = PosAccessKey(id=access_control.OWNER_ID, name="Administrator",
                                 password_hash=hash_pin(ADMIN_PASSWORD),
                                 areas=json.dumps(list(access_control.AREAS)),
                                 is_admin=True, enabled=True, version=1)
            s.add(owner)
        area_key = s.query(PosAccessKey).filter_by(is_admin=False, name="Demo dispatch password").first()
        if not area_key:
            s.add(PosAccessKey(id="KEY-DEMO-ORDERS", name="Demo dispatch password",
                               password_hash=hash_pin(ORDERS_PASSWORD),
                               areas=json.dumps(["orders"]),
                               is_admin=False, enabled=True, version=1))

        # 3) Rider roster entry
        rider = s.get(Rider, RID)
        if not rider:
            rider = Rider(id=RID, name="Kato Brian", phone="0772555010",
                          status="Available", vehicle_plate="UEP 442X",
                          vehicle="Motorbike (Boda)", zone="Kololo · Nakawa · Central",
                          archived=False)
            s.add(rider)

        # Clean any previous demo pairing / device / delivery events / orders
        s.query(RiderPairing).filter_by(rider_id=RID).delete()
        s.query(RiderDevice).filter_by(rider_id=RID).delete()
        from models import DeliveryEvent
        s.query(DeliveryEvent).filter(DeliveryEvent.order_id.in_(["AT-DEMO-1", "AT-DEMO-2"])).delete()
        s.query(OrderItem).filter(OrderItem.order_id.in_(["AT-DEMO-1", "AT-DEMO-2"])).delete()
        s.query(Order).filter(Order.id.in_(["AT-DEMO-1", "AT-DEMO-2"])).delete()
        s.query(Product).filter(Product.id.in_(["PRD-DEMO-1", "PRD-DEMO-2"])).delete()
        s.flush()

        # 4) Live pairing code (production codes last 10 minutes; the demo keeps
        #    it alive for an hour — re-run this seed to refresh it)
        s.add(RiderPairing(rider_id=RID, code_hash=dispatch.digest(PAIRING_CODE),
                           expires_at=now() + timedelta(minutes=60), issued_by="Demo seed"))

        # 5) Two demo products
        for pid, sku, name, price, demog, cat in [
            ("PRD-DEMO-1", "ADN-DEMO-1001", "Indigo Type III Trucker Jacket", 85000, "Men", "Jackets"),
            ("PRD-DEMO-2", "ADN-DEMO-1002", "Ankara Print Midi Dress", 60000, "Women", "Dresses"),
        ]:
            s.add(Product(id=pid, sku=sku, barcode_id=sku, name=name, brand="Adonai Vintage",
                          demographic=demog, category=cat, size="M",
                          item_condition="PRE_LOVED", quantity_type="PRE_LOVED",
                          condition="Grade A", base_price=price, total_transport_cost=0,
                          selling_price=price, in_stock_count=1,
                          slug=name.lower().replace(" ", "-") + "-demo"))

        # 6) Two paid web delivery orders
        def mk_order(oid, customer, phone, address, area, pid, price, fee, notes):
            order = Order(
                id=oid, channel="web", status="processing", dispatch_status="In Assembly",
                customer_name=customer, customer_phone=phone, customer_address=address,
                delivery_type="boda", delivery_area=area, delivery_fee=fee, delivery_notes=notes,
                subtotal=price, total=price + fee, tender_type="momo", payment_status="paid",
                payment_provider="momo", payment_channel="mtn", payment_reference="DEMO-TXN-" + oid[-1],
                paid_at=now(), cashier_name="Web checkout", created_at=now(), updated_at=now())
            s.add(order)
            s.add(OrderItem(id="ODI-" + uuid.uuid4().hex[:12], order_id=oid, product_id=pid,
                            barcode_id=pid, name="Demo item for " + oid,
                            item_condition="PRE_LOVED", quantity_type="PRE_LOVED",
                            unit_price=price, unit_cost=price // 2, category="Demo",
                            qty=1, line_total=price))
            return order

        order1 = mk_order("AT-DEMO-1", "Sarah Nansubuga", "0772123456",
                          "Plot 12 Kololo Terrace, off Acacia Avenue", "Kololo",
                          "PRD-DEMO-1", 85000, 5000, "Leave with the gatekeeper if I am out.")
        order2 = mk_order("AT-DEMO-2", "Okello Denis", "0759876543",
                          "Nakawa Industrial Area, Plot 7", "Nakawa",
                          "PRD-DEMO-2", 60000, 5000, "Call when you reach the roundabout.")
        s.flush()

        # 7) Dispatch the first order to the rider (same server code path staff use)
        dispatch.assign(s, order1, RID, "Demo Dispatch")
        s.commit()

        print("Demo data ready.")
        print(f"  Orders-area password (dispatch console & GPS board): {ORDERS_PASSWORD}")
        print(f"  Owner/admin password (settings/security):            {ADMIN_PASSWORD}")
        print(f"  Rider: Kato Brian ({RID}) — phone pairing code:     {PAIRING_CODE}")
        print("  AT-DEMO-1  paid + dispatched to Kato Brian (appears in the rider app)")
        print("  AT-DEMO-2  paid + In Assembly (assign it from the dispatch console)")


if __name__ == "__main__":
    seed()
