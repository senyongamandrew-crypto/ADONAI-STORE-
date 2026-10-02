"""Canonical 50/50 transport allocation rules shared by inventory and checkout."""
from decimal import Decimal, ROUND_HALF_UP

HALF = Decimal("0.50")
MONEY = Decimal("0.01")


def transport_allocation(base_price, total_transport_cost):
    """Return the two transport portions and storefront price as Decimal values."""
    base = Decimal(str(base_price or 0)).quantize(MONEY, rounding=ROUND_HALF_UP)
    transport = Decimal(str(total_transport_cost or 0)).quantize(MONEY, rounding=ROUND_HALF_UP)
    if base < 0 or transport < 0:
        raise ValueError("Prices and transport cost cannot be negative")
    embedded = (transport * HALF).quantize(MONEY, rounding=ROUND_HALF_UP)
    checkout = transport - embedded  # guarantees exact reconciliation for odd cents
    return {
        "base_price": base,
        "total_transport_cost": transport,
        "embedded_transport_portion": embedded,
        "checkout_transport_portion": checkout,
        "final_selling_price": (base + embedded).quantize(MONEY, rounding=ROUND_HALF_UP),
    }


def whole_money(value):
    """The current POS displays whole UGX; round a Decimal for legacy integer fields."""
    return int(Decimal(str(value or 0)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
