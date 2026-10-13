"""Partner consignment rules shared by intake, checkout settlement and payouts.

Pure functions only (no database access) so the financial arithmetic can be
tested in isolation. Every amount is whole Ugandan shillings (UGX).

Economic model (agent / consignment):
  * Adonai Store earns COMMISSION_RATE of each consignment sale line.
  * The partner is owed the remainder of that same sale line.
  * Commission + partner share always equals the line total exactly.

Each constant below is a business decision. Change it here, in one place, and
the tests in tests/test_consignment.py will tell you what else moves.
"""
from decimal import Decimal, ROUND_HALF_UP

# --- Financial policy ------------------------------------------------------
COMMISSION_RATE = Decimal("0.05")          # 5.00% platform commission on the sale line
DUAL_APPROVAL_THRESHOLD = 300_000          # UGX: payouts at/above this need a second manager

# --- Intake media standard (per consignment item) --------------------------
PHOTO_MIN = 5
PHOTO_MAX = 6
VIDEO_MAX_SECONDS = 15.0
VIDEO_TOLERANCE_SECONDS = 0.5              # encoder rounding tolerance

PAYOUT_CHANNELS = {
    "MOBILE_MONEY": "mobile_money",
    "MERCHANT_CODE": "mobile_money",
    "BANK_ACCOUNT": "bank",
    "CASH": "cash",
}

PAYOUT_STATUSES = ("REQUESTED", "APPROVED", "PAID", "REJECTED")
OPEN_PAYOUT_STATUSES = ("REQUESTED", "APPROVED")
COMPLETED_ORDER_STATUS = "completed"       # an order must be fulfilled before its share is payable


def split_sale_line(line_total: int) -> tuple[int, int]:
    """Return (commission, partner_share) for one consignment sale line.

    Commission is rounded half-up to whole shillings; the partner receives the
    exact remainder, so the two parts always reconcile to the line total.
    """
    total = int(line_total)
    if total < 0:
        raise ValueError("Sale line total cannot be negative")
    commission = int((Decimal(total) * COMMISSION_RATE).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    return commission, total - commission


def validate_media(photo_count: int, video_seconds) -> list[str]:
    """Return a list of human-readable media problems (empty list = compliant)."""
    problems = []
    photos = int(photo_count or 0)
    if photos < PHOTO_MIN:
        problems.append(f"Needs at least {PHOTO_MIN} photos (has {photos}).")
    elif photos > PHOTO_MAX:
        problems.append(f"Accepts at most {PHOTO_MAX} photos (has {photos}).")
    if video_seconds is None:
        problems.append("A garment video is required.")
    else:
        seconds = float(video_seconds)
        if seconds <= 0:
            problems.append("The garment video has no duration.")
        elif seconds > VIDEO_MAX_SECONDS + VIDEO_TOLERANCE_SECONDS:
            problems.append(f"The garment video must be {int(VIDEO_MAX_SECONDS)} seconds or less (is {seconds:.1f}s).")
    return problems


def normalise_payout_channel(channel: str) -> str:
    value = str(channel or "").strip().upper().replace("-", "_").replace(" ", "_")
    if value not in PAYOUT_CHANNELS:
        raise ValueError("Payout channel must be Mobile Money, Merchant Code, Bank Account or Cash")
    return value


def validate_payout_account(channel: str, account: str) -> str:
    """Format-check the payout destination. Ownership is verified manually by staff."""
    value = normalise_payout_channel(channel)
    account = str(account or "").strip()
    if value == "CASH":
        return ""  # cash is handed over in person; no account to validate
    if value == "MOBILE_MONEY":
        digits = account.replace(" ", "").replace("-", "")
        if digits.startswith("+256"):
            digits = "0" + digits[4:]
        if not (len(digits) == 10 and digits.startswith("0") and digits.isdigit()):
            raise ValueError("Mobile Money number must be a Ugandan mobile number, e.g. 0770 123 456")
        return digits
    if value == "MERCHANT_CODE":
        if not (account.isdigit() and 4 <= len(account) <= 10):
            raise ValueError("Merchant code must be 4 to 10 digits")
        return account
    # BANK_ACCOUNT
    if len(account) < 6:
        raise ValueError("Bank account number must be at least 6 characters")
    return account


def mask_account(account: str) -> str:
    """Show only the last three characters of sensitive identifiers."""
    text = str(account or "")
    if len(text) <= 3:
        return "•" * len(text)
    return "•" * (len(text) - 3) + text[-3:]


def required_kyc_problems(payload: dict) -> list[str]:
    problems = []
    if not str(payload.get("partner_name") or "").strip():
        problems.append("Partner name is required")
    if not str(payload.get("phone_whatsapp") or "").strip():
        problems.append("WhatsApp phone number is required")
    if not str(payload.get("identity_reference") or "").strip():
        problems.append("NIN or business registration reference is required")
    return problems


def reconcile(partner_share_total: int, journal_payable_balance: int, paid_total: int) -> dict:
    """Compare ledger views of what is owed to partners.

    expected_payable = total partner shares recorded on sales − payouts already paid.
    The journal balance on account 2100 must equal that expectation exactly.
    """
    expected = int(partner_share_total) - int(paid_total)
    difference = int(journal_payable_balance) - expected
    return {
        "expected_payable": expected,
        "journal_payable": int(journal_payable_balance),
        "difference": difference,
        "balanced": difference == 0,
    }
