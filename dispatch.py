"""Consent-based rider dispatch. Latest-point GPS, never serial/IMEI tracking.
Admin location data requires an authenticated staff deployment or a deliberately
protected Orders scope, independently of the always-open cashier register.
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import base64
import hashlib
import json
import logging
import math
import os
import random
import re
import secrets
import urllib.error
import urllib.request
import uuid
from urllib.parse import quote

from database import get_db
from models import (Rider, RiderAccount, RiderAttendance, RiderDevice, RiderPairing, DeliveryEvent,
                    Order, OrderItem, Product, User)
from media import MediaResponse
import access_control
from notifications import broadcast_event

logger = logging.getLogger("adonai.dispatch")
WHATSAPP_TIMEOUT_SECONDS = 8
WHATSAPP_GRAPH_VERSION = "v21.0"

FRESH_SECONDS = 90
POINT_RETENTION = timedelta(hours=24)
SESSION_LIFE = timedelta(days=30)
DUTY_LIFE = timedelta(hours=12)
RIDER_STATES = {"Available", "On delivery", "Offline"}
PROGRESS = {"accepted", "collected", "arrived", "delivered", "issue"}

class DispatchError(Exception):
    def __init__(self, message, status=400, code=None):
        super().__init__(message); self.status = status; self.code = code


def response(data, status=200):
    return MediaResponse(status, "application/json; charset=utf-8", json.dumps(data, ensure_ascii=False).encode(),
                         {"Cache-Control":"private, no-store", "Referrer-Policy":"no-referrer"})


def fail(message, status=400, code=None):
    raise DispatchError(message, status, code)


def now(): return datetime.utcnow()
def iso(value): return value.isoformat(timespec="seconds") + "Z" if value else None
def digest(value): return hashlib.sha256(value.encode()).hexdigest()
def uid(prefix): return prefix + "-" + uuid.uuid4().hex


def notify_rider(session, event_type, title, message, rider, **details):
    """Attach rider and delivery bell activity to the business transaction.

    Never include device credentials, phone numbers, pairing codes, or GPS fixes.
    """
    allowed_details = {"status", "changed_fields", "order_id", "fulfillment_status",
                       "delivery_progress", "rider_status"}
    payload = {"rider_id": rider.id, "rider_name": rider.name}
    payload.update({key: value for key, value in details.items() if key in allowed_details})
    return broadcast_event(event_type, title, message, payload, session=session)


def text(value, maximum, field, required=False):
    if not isinstance(value, str): fail(f"{field} must be text.")
    value = " ".join(value.split())
    if len(value) > maximum: fail(f"{field} must be at most {maximum} characters.")
    if required and not value: fail(f"{field} is required.")
    return value


def policy_active(session, staff_required):
    return staff_required or "orders" in access_control.state(session=session)["protected"]


def demo_mode():
    return os.environ.get("ADONAI_DELIVERY_DEMO") == "1"


KAMPALA_TZ = ZoneInfo("Africa/Kampala")


def kampala_day():
    return datetime.now(KAMPALA_TZ).strftime("%Y-%m-%d")


def attendance_gate(session, rider):
    """Riders who sign in to an account must check in once per Kampala day.

    Riders paired through the native APK path (no account) are not gated.
    """
    account = session.query(RiderAccount).filter_by(rider_id=rider.id).first()
    if account is None:
        return {"required": False, "checked_in_today": True}
    row = session.query(RiderAttendance).filter_by(account_id=account.id, day=kampala_day()).first()
    return {"required": True, "checked_in_today": row is not None}


def gps_access(session, headers, staff, staff_required):
    access = access_control.state(headers, session)
    if not policy_active(session,staff_required): return False
    identity=str((staff or {}).get("id", ""))
    if staff_required and not identity.startswith("ENV-"):
        user=session.get(User,identity)
        if not user or not user.active: return False
    # No public location feed in the default PIN-free deployment. Protect this
    # one area or use the existing opt-in staff authentication; never gate POS.
    return bool(access["admin_unlocked"] or ("orders" in access["protected"] and "orders" in access["granted"])
                or (staff_required and (staff or {}).get("role") in {"admin", "manager"} and access_control.allowed("orders", access)))


def require_gps_access(session, headers, staff, staff_required):
    if not gps_access(session, headers, staff, staff_required):
        fail("To enable native APK pairing/GPS: Admin Suite → Store Settings → scroll to Passwords & protected areas → protect Orders, dispatch & audit and save; then unlock that area in Dispatch. Checkout stays open. For rider accounts/jobs without GPS, use Delivery account code instead; no GPS protection is needed.",403,"TRACKING_PRIVACY_SETUP")


def prune_points(session):
    # Latest point only, bounded retention on activity. No route-history table.
    session.query(RiderDevice).filter(RiderDevice.fix_at < now() - POINT_RETENTION).update(
        {"latitude":None, "longitude":None, "accuracy":None, "fix_at":None, "received_at":None}, synchronize_session=False)
    session.query(RiderPairing).filter(RiderPairing.expires_at <= now()).delete(synchronize_session=False)


def live_state(device):
    if not device or device.revoked or device.expires_at <= now(): return {"state":"unpaired", "device_label":None, "point":None}
    duty = bool(device.sharing and device.duty_until and device.duty_until > now())
    point = None
    if device.fix_at and device.latitude is not None and now() - device.fix_at <= POINT_RETENTION:
        age = max(0, int((now() - device.fix_at).total_seconds()))
        point = {"latitude":device.latitude, "longitude":device.longitude, "accuracy_m":device.accuracy,
                 "fix_at":iso(device.fix_at), "received_at":iso(device.received_at), "age_seconds":age, "mock":bool(device.mock_location)}
    state = "paused" if not duty else "waiting" if point is None else "simulated" if device.mock_location else "live" if point["age_seconds"] <= FRESH_SECONDS else "stale"
    return {"state":state,"device_label":device.label,"paired_at":iso(device.paired_at),"duty_until":iso(device.duty_until) if duty else None,
            "sharing":duty,"point":point,"fresh_seconds":FRESH_SECONDS}


def rider_by_id(session, identity, lock=False):
    query = session.query(Rider).filter_by(id=identity, archived=False)
    rider = (query.with_for_update() if lock else query).first()
    if not rider: fail("Rider not found or archived.",404)
    return rider


def device_from_request(session, headers):
    authorization = next((str(value) for key,value in headers.items() if key.lower()=="authorization"),"")
    token = authorization[7:] if authorization.startswith("Bearer ") else ""
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token): fail("Pair this phone again. Rider session is missing or invalid.",401)
    device = session.query(RiderDevice).filter_by(token_hash=digest(token)).with_for_update().first()
    if not device or device.revoked or device.expires_at <= now(): fail("This phone's pairing expired or was revoked. Pair it again.",401)
    rider = rider_by_id(session, device.rider_id)
    return device, rider


def event_dict(event):
    return {"id":event.id,"order_id":event.order_id,"rider_id":event.rider_id,"stage":event.stage,
            "note":event.note or "","received_by":event.received_by or "","created_at":iso(event.created_at)}


def order_brief(order, latest=None):
    return {"id":order.id,"customer_name":order.customer_name or "Customer","customer_phone":order.customer_phone or "",
            "address":order.customer_address or "","area":order.delivery_area or "","notes":order.delivery_notes or "",
            "total":int(order.total or 0),"delivery_fee":int(order.delivery_fee or 0),
            "dispatch_status":order.dispatch_status,"rider_id":order.rider_id,
            "rider_name":order.rider_name or "","paid":order.payment_status=="paid","delivery_type":order.delivery_type,
            "created_at":iso(order.created_at),"progress":event_dict(latest) if latest else None}


def add_event(session, order, rider, stage, device=None, note="", received_by=""):
    event = DeliveryEvent(id=uid("DLE"),order_id=order.id,rider_id=rider.id,device_id=device.id if device else None,
                          stage=stage,note=note,received_by=received_by,created_at=now())
    session.add(event)
    return event


def validate_assignment(session, order, rider_id):
    rider = rider_by_id(session, rider_id, True)
    if rider.status == "Offline": fail("This rider is offline. Choose an available/on-delivery partner.",409)
    if order.channel != "web" or order.delivery_type == "pickup": fail("Only delivery orders can be assigned to a rider.",409)
    if order.payment_status != "paid": fail("Confirm customer payment before dispatching this order.",409)
    if order.status in {"cancelled","canceled","completed"} or order.dispatch_status not in {"In Assembly","Dispatched"}:
        fail("Prepare the paid order first (In Assembly), then assign & dispatch. Closed/pickup orders cannot be assigned.",409)
    return rider


def whatsapp_number(phone):
    """Digits-only WhatsApp (international) number; Ugandan 07… numbers get 256."""
    digits = re.sub(r"\D", "", str(phone or ""))
    if len(digits) == 10 and digits.startswith("0"): digits = "256" + digits[1:]
    return digits if 9 <= len(digits) <= 15 else ""


def wa_link(number, message):
    return f"https://wa.me/{number}?text={quote(message)}"


def rider_message(order, rider):
    """Plain-language assignment text for the rider. Staff-only scope; never sent to customers."""
    items = [f"{int(item.qty or 1)} × {item.name}" for item in (order.items or [])][:6]
    lines = [
        f"Hello {rider.name}, Adonai Store has assigned you a delivery.",
        f"Order: {order.id}",
        f"Customer: {order.customer_name or 'Customer'}" + (f" · {order.customer_phone}" if order.customer_phone else ""),
        f"Deliver to: {order.customer_address or order.delivery_area or 'Confirm the address with the customer'}",
    ]
    if order.delivery_notes: lines.append(f"Delivery notes: {order.delivery_notes}")
    if items: lines.append("Items: " + ", ".join(items))
    lines.append(f"Amount: UGX {int(order.total or 0):,} (paid)")
    lines.append("Open the Adonai rider app, accept the delivery, and report each step.")
    return "\n".join(lines)[:1500]


def send_whatsapp(number, message):
    """Send via the WhatsApp Cloud API when configured. Never raises; returns a status dict."""
    token = os.environ.get("WHATSAPP_ACCESS_TOKEN", "").strip()
    phone_id = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "").strip()
    if not token or not phone_id: return {"status": "not_configured", "error": "WhatsApp auto-send is not configured on the server."}
    if not number: return {"status": "failed", "error": "The rider's phone number is missing or not a valid WhatsApp number."}
    template = os.environ.get("WHATSAPP_RIDER_TEMPLATE", "").strip()
    if template:
        # Business-initiated messages outside the 24h window need an approved template.
        payload = {"messaging_product": "whatsapp", "to": number, "type": "template",
                   "template": {"name": template, "language": {"code": os.environ.get("WHATSAPP_TEMPLATE_LANG", "en").strip() or "en"},
                                "components": [{"type": "body", "parameters": [{"type": "text", "text": message[:1024]}]}]}}
    else:
        payload = {"messaging_product": "whatsapp", "to": number, "type": "text", "text": {"body": message[:4096], "preview_url": False}}
    version = os.environ.get("WHATSAPP_GRAPH_VERSION", WHATSAPP_GRAPH_VERSION).strip() or WHATSAPP_GRAPH_VERSION
    request = urllib.request.Request(f"https://graph.facebook.com/{version}/{quote(phone_id)}/messages",
                                     data=json.dumps(payload).encode("utf-8"), method="POST",
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=WHATSAPP_TIMEOUT_SECONDS) as reply:
            body = json.loads(reply.read().decode("utf-8") or "{}")
        if body.get("messages"): return {"status": "sent", "error": ""}
        return {"status": "failed", "error": "WhatsApp accepted the request without a message id."}
    except urllib.error.HTTPError as error:
        detail = ""
        try: detail = str((json.loads(error.read().decode("utf-8") or "{}").get("error") or {}).get("message", ""))[:200]
        except Exception: detail = ""
        logger.warning("WhatsApp rider message rejected with HTTP %s", error.code)
        return {"status": "failed", "error": f"WhatsApp rejected the message (HTTP {error.code}){': ' + detail if detail else ''}"}
    except (urllib.error.URLError, OSError, ValueError) as error:
        logger.warning("WhatsApp rider message could not be sent: %s", type(error).__name__)
        return {"status": "failed", "error": "WhatsApp could not be reached. Try again or message the rider directly."}


def deliver_rider_notices(outbox):
    """Runs AFTER the assignment transaction commits, so a rider never hears about a rolled-back job."""
    results = []
    for notice in outbox:
        outcome = send_whatsapp(notice["to"], notice["message"])
        link = wa_link(notice["to"], notice["message"]) if notice["to"] else None
        suffix = " · WhatsApp to rider: sent" if outcome["status"] == "sent" else " · WhatsApp to rider: not sent — message the rider"
        # Recorded on the assignment itself (visible on the dispatch timeline); one activity bell per assignment.
        with get_db() as session:
            event = session.get(DeliveryEvent, notice["event_id"])
            if event: event.note = ((event.note or "").split(" · WhatsApp to rider")[0] + suffix)[:500]
        results.append({"status": outcome["status"], "error": outcome["error"],
                        "wa_link": link if outcome["status"] != "sent" else None, "rider_id": notice["rider_id"]})
    return results


def assign(session, order, rider_id, staff_name, outbox=None):
    rider = validate_assignment(session, order, rider_id)
    if order.rider_id == rider.id and order.dispatch_status == "Dispatched": return rider
    previous = order.rider_id
    old_status = rider.status
    order.rider_id = rider.id; order.rider_name = rider.name; order.dispatch_status = "Dispatched"; order.status = "processing"; order.updated_at = now()
    if order.dispatched_at is None: order.dispatched_at = now()
    rider.status = "On delivery"
    event = add_event(session, order, rider, "assigned", note=f"Assigned by {staff_name}"[:500])
    if outbox is not None:
        outbox.append({"event_id": event.id, "order_id": order.id, "rider_id": rider.id, "rider_name": rider.name,
                       "to": whatsapp_number(rider.phone), "message": rider_message(order, rider)})
    released = None
    if previous and previous != rider.id:
        old = session.get(Rider, previous)
        other_jobs = session.query(Order).filter(Order.rider_id==previous,Order.id!=order.id,Order.dispatch_status=="Dispatched",Order.status.notin_(["cancelled","completed"])).count()
        if old and old.status == "On delivery" and not other_jobs:
            old.status = "Available"
            released = old
    assigned_message = f"Assigned to {rider.name}"
    if old_status != rider.status:
        assigned_message += f" · now {rider.status}"
    notify_rider(session, "DELIVERY_ASSIGNED", f"Order {order.id} dispatched", assigned_message, rider,
                 order_id=order.id, fulfillment_status="Dispatched", rider_status=rider.status)
    if released:
        notify_rider(session, "RIDER_STATUS_UPDATED", "Partner availability changed",
                     f"{released.name} is now {released.status}.", released, status=released.status)
    return rider


def board(session, headers, staff, staff_required):
    private = gps_access(session,headers,staff,staff_required)
    prune_points(session)
    riders = session.query(Rider).filter_by(archived=False).order_by(Rider.name).all()
    devices = {d.rider_id:d for d in session.query(RiderDevice).all()} if private else {}
    orders = session.query(Order).filter(Order.channel=="web",Order.delivery_type!="pickup",Order.payment_status=="paid",
                 Order.status.notin_(["cancelled","canceled","completed"]),Order.dispatch_status.in_(["In Assembly","Dispatched"])).order_by(Order.created_at).all()
    latest = {}
    if orders:
        for event in session.query(DeliveryEvent).filter(DeliveryEvent.order_id.in_([o.id for o in orders])).order_by(DeliveryEvent.created_at.desc(),DeliveryEvent.id.desc()).all():
            if event.order_id not in latest: latest[event.order_id]=event
    records=[]
    for rider in riders:
        records.append({**rider.to_dict(),"active_jobs":sum(1 for order in orders if order.rider_id==rider.id),
                        "tracking":live_state(devices.get(rider.id)) if private else {"state":"protected","point":None}})
    events = session.query(DeliveryEvent).order_by(DeliveryEvent.created_at.desc()).limit(30).all()
    by_id={rider.id:rider for rider in riders}
    briefs=[]
    for order in orders:
        brief=order_brief(order,latest.get(order.id))
        rider=by_id.get(order.rider_id)
        number=whatsapp_number(rider.phone) if rider else ""
        if rider and number: brief["rider_wa_link"]=wa_link(number,rider_message(order,rider))
        briefs.append(brief)
    return {"ok":True,"riders":records,"orders":briefs,
            "events":[event_dict(event) for event in events],"gps_access":private,"server_time":iso(now()),"fresh_seconds":FRESH_SECONDS,
            "privacy_message":None if private else "To enable native APK phone pairing/GPS: Admin Suite → Store Settings → scroll to Passwords & protected areas → protect Orders, dispatch & audit and save. Then unlock that area in Dispatch. Checkout stays open. If you only need rider accounts and job assignments (no GPS), use Delivery account code instead; no GPS protection is needed."}


def route_request(method, path, body, headers, staff, staff_required=False):
    # Rider WhatsApp messages are sent only after the assignment commits.
    outbox = []
    try:
        with get_db() as session:
            result = _route(session, outbox, method, path, body, headers, staff, staff_required)
    except DispatchError as error:
        return response({"ok":False,"error":str(error),"code":error.code},error.status)
    if outbox:
        result = attach_notices(result, deliver_rider_notices(outbox))
    return result


def attach_notices(result, notices):
    try: payload = json.loads(result[2])
    except (TypeError, ValueError): return result
    if isinstance(payload, dict) and payload.get("ok"):
        payload["rider_notice"] = notices[0] if len(notices) == 1 else notices
        return response(payload, result[0])
    return result


def _route(session, outbox, method, path, body, headers, staff, staff_required):
    if path == "/api/dispatch/board" and method == "GET": return response(board(session,headers,staff,staff_required))
    if path == "/api/riders" and method == "GET":
        return response({"ok":True,"riders":[r.to_dict() for r in session.query(Rider).filter_by(archived=False).order_by(Rider.name).all()]})
    if path == "/api/riders" and method == "POST":
        rider = Rider(id=uid("RDR"),name=text(body.get("name",""),100,"Rider name",True),phone=text(body.get("phone",""),50,"Phone",True),
                      vehicle=text(body.get("vehicle","Motorbike (Boda)"),100,"Vehicle"),vehicle_plate=text(body.get("plate",""),50,"Vehicle plate"),
                      zone=text(body.get("zone",""),100,"Service zone"),status="Available",archived=False)
        session.add(rider);session.flush()
        notify_rider(session, "RIDER_ADDED", "Delivery partner added", f"{rider.name} was added to the active roster.", rider,
                     status=rider.status)
        return response({"ok":True,"rider":rider.to_dict()},201)
    if re.fullmatch(r"/api/riders/[^/]+",path) and method in {"PATCH","DELETE"}:
        rider = rider_by_id(session,path.rsplit("/",1)[1],True)
        if method=="DELETE":
            if session.query(Order).filter_by(rider_id=rider.id,dispatch_status="Dispatched").filter(Order.status.notin_(["cancelled","completed"])).count():
                fail("Reassign this rider's active deliveries before archiving.",409)
            rider.archived=True;rider.status="Offline"
            device=session.query(RiderDevice).filter_by(rider_id=rider.id).first()
            if device: device.revoked=True;device.sharing=False;device.latitude=None;device.longitude=None
            session.query(RiderPairing).filter_by(rider_id=rider.id).delete()
            notify_rider(session, "RIDER_ARCHIVED", "Delivery partner archived",
                         f"{rider.name} was removed from the active roster.", rider)
            return response({"ok":True})
        changed_fields=[]
        for key,maximum in [("name",100),("phone",50),("vehicle",100),("zone",100),("plate",50)]:
            if key in body:
                attribute="vehicle_plate" if key=="plate" else key
                value=text(body[key],maximum,key,key in {"name","phone"})
                if getattr(rider,attribute)!=value:
                    setattr(rider,attribute,value)
                    changed_fields.append(key)
        status_changed=False
        if "status" in body:
            if body["status"] not in RIDER_STATES: fail("Choose Available, On delivery or Offline.")
            if body["status"]=="Offline" and session.query(Order).filter_by(rider_id=rider.id,dispatch_status="Dispatched").filter(Order.status.notin_(["cancelled","completed"])).count():
                fail("Reassign this rider's active jobs before marking Offline.",409)
            if rider.status!=body["status"]:
                rider.status=body["status"]
                status_changed=True
        if status_changed and not changed_fields:
            notify_rider(session, "RIDER_STATUS_UPDATED", "Partner availability changed",
                         f"{rider.name} is now {rider.status}.", rider, status=rider.status)
        elif changed_fields or status_changed:
            fields=changed_fields + (["availability"] if status_changed else [])
            message=f"{rider.name}'s profile changed: {', '.join(fields)}."
            if status_changed:
                message+=f" Availability is now {rider.status}."
            notify_rider(session, "RIDER_UPDATED", "Partner profile updated", message, rider,
                         changed_fields=fields, status=rider.status)
        session.flush();return response({"ok":True,"rider":rider.to_dict()})
    match=re.fullmatch(r"/api/dispatch/riders/([^/]+)/app-code",path)
    if match and method=="POST":
        # Adonai Delivery onboarding. api.py already requires staff dispatch
        # authorization for every /api/dispatch/* route, and the orders-area
        # guard still applies when that area is protected. Unlike /pair this
        # code grants the JOB INBOX only: it cannot enable GPS because
        # duty/start, /location and the GPS board all still require
        # policy_active(). A store can therefore onboard riders without ever
        # switching on live tracking.
        rider=rider_by_id(session,match[1],True)
        code=base64.b32encode(secrets.token_bytes(7)).decode()[:10]
        row=session.get(RiderPairing,rider.id)
        if not row: row=RiderPairing(rider_id=rider.id);session.add(row)
        row.code_hash=digest(code);row.expires_at=now()+timedelta(minutes=10)
        row.issued_by=str((staff or {}).get("name","Dispatcher"))[:100]
        notify_rider(session,"DELIVERY_APP_CODE_ISSUED","Delivery app connection code issued",
                     f"A connection code was issued for {rider.name}'s Adonai Delivery app. Location sharing stays off.",rider)
        return response({"ok":True,"code":code[:5]+"-"+code[5:],"expires_at":iso(row.expires_at),
                         "rider":rider.to_dict(),"purpose":"delivery-app","app_url":"/delivery"},201)
    match=re.fullmatch(r"/api/dispatch/riders/([^/]+)/(pair|revoke)",path)
    if match and method=="POST":
        require_gps_access(session,headers,staff,staff_required); rider=rider_by_id(session,match[1],True)
        if match[2]=="revoke":
            device=session.query(RiderDevice).filter_by(rider_id=rider.id).with_for_update().first()
            pairing_query=session.query(RiderPairing).filter_by(rider_id=rider.id)
            had_access=bool((device and not device.revoked) or pairing_query.first())
            if device: device.revoked=True;device.sharing=False;device.latitude=None;device.longitude=None;device.fix_at=None;device.received_at=None
            pairing_query.delete(synchronize_session=False)
            if had_access:
                notify_rider(session, "RIDER_PHONE_REVOKED", "Partner phone access revoked",
                             f"{rider.name}'s paired phone access was revoked.", rider)
            return response({"ok":True})
        code=base64.b32encode(secrets.token_bytes(7)).decode()[:10]
        row=session.get(RiderPairing,rider.id)
        if not row: row=RiderPairing(rider_id=rider.id);session.add(row)
        row.code_hash=digest(code);row.expires_at=now()+timedelta(minutes=10);row.issued_by=str((staff or {}).get("name","Dispatcher"))[:100]
        notify_rider(session, "RIDER_PAIRING_CODE_ISSUED", "Partner pairing code issued",
                     f"A phone-pairing code was generated for {rider.name}; it expires in 10 minutes.", rider)
        return response({"ok":True,"code":code[:5]+"-"+code[5:],"expires_at":iso(row.expires_at),"rider":rider.to_dict()},201)
    match=re.fullmatch(r"/api/dispatch/orders/([^/]+)/assign",path)
    if match and method=="POST":
        order=session.query(Order).filter_by(id=match[1]).with_for_update().first()
        if not order: fail("Order not found.",404)
        assign(session,order,text(body.get("rider_id",""),50,"Rider",True),str((staff or {}).get("name","Dispatcher")),outbox)
        session.flush();return response({"ok":True,"order":access_control.sanitize_sale(order.to_dict(),access_control.state(headers,session))})
    if path == "/api/rider/pair" and method=="POST":
        if not policy_active(session,staff_required): fail("Dispatch GPS must be protected before pairing phones.",403,"TRACKING_PRIVACY_SETUP")
        code=re.sub(r"[\s-]","",str(body.get("code",""))).upper()
        if not re.fullmatch(r"[A-Z2-7]{10}",code): fail("Pairing code is invalid or expired.",403)
        pairing=session.query(RiderPairing).filter_by(code_hash=digest(code)).with_for_update().first()
        if not pairing or pairing.expires_at<=now(): fail("Pairing code is invalid or expired.",403)
        rider=rider_by_id(session,pairing.rider_id,True)
        label=text(body.get("device_label","Android rider phone"),100,"Phone label",True)
        device=session.query(RiderDevice).filter_by(rider_id=rider.id).with_for_update().first()
        token=secrets.token_urlsafe(32)
        if not device: device=RiderDevice(id=uid("RDP"),rider_id=rider.id);session.add(device)
        device.label=label;device.token_hash=digest(token);device.expires_at=now()+SESSION_LIFE;device.revoked=False;device.sharing=False
        device.duty_until=None;device.latitude=None;device.longitude=None;device.accuracy=None;device.fix_at=None;device.received_at=None;device.sequence=0;device.paired_at=now()
        session.delete(pairing);session.flush()
        notify_rider(session, "RIDER_PHONE_PAIRED", "Partner phone paired",
                     f"{rider.name}'s phone was paired. Location sharing stays off until a duty starts.", rider)
        return response({"ok":True,"session_token":token,"rider":rider.to_dict(),"device_id":device.id,"expires_at":iso(device.expires_at)},201)
    if path == "/api/dispatch/attendance" and method == "GET":
        import rider_accounts
        return rider_accounts.dispatch_attendance(session)
    match = re.fullmatch(r"/api/dispatch/attendance/([^/]+)/(selfie|signature)", path)
    if match and method == "GET":
        import rider_accounts
        return rider_accounts.dispatch_image(session, match[1], match[2])
    if path == "/api/rider/demo-status" and method == "GET":
        # Public capability flag with no secrets: lets the rider app offer the
        # local demo connect code when this deployment is a review sandbox.
        # Production deployments never set ADONAI_DELIVERY_DEMO.
        return response({"ok":True,"demo":os.environ.get("ADONAI_DELIVERY_DEMO")=="1"})
    if path == "/api/rider/connect" and method == "POST":
        # Retired: a connection code alone no longer links a phone. Riders sign
        # in to their Adonai Delivery account, check in, then enter the code.
        fail("Sign in to your Adonai Delivery account first, then enter the connection code.", 410, "CONNECT_MOVED")
    if path.startswith("/api/rider/"):
        device,rider=device_from_request(session,headers);prune_points(session)
        if path=="/api/rider/me" and method=="GET":
            jobs=session.query(Order).filter_by(rider_id=rider.id,dispatch_status="Dispatched").filter(Order.status.notin_(["cancelled","completed"])).order_by(Order.created_at).all()
            latest={}
            for event in session.query(DeliveryEvent).filter(DeliveryEvent.order_id.in_([o.id for o in jobs]),DeliveryEvent.rider_id==rider.id).order_by(DeliveryEvent.created_at.desc(),DeliveryEvent.id.desc()).all():
                if event.order_id not in latest: latest[event.order_id]=event
            gate=attendance_gate(session,rider)
            return response({"ok":True,"rider":rider.to_dict(),"tracking":live_state(device),
                             "orders":[order_brief(o,latest.get(o.id)) for o in jobs],"server_time":iso(now()),
                             "gps_policy":policy_active(session,staff_required),
                             "attendance_required":gate["required"],"checked_in_today":gate["checked_in_today"],
                             "demo":demo_mode()})
        # ---- Adonai Delivery: job inbox detail, acceptance, refusal, --------
        # availability, completed history and delivery fees. Every route is
        # scoped to the paired device's own rider; a rider can never read or
        # mutate another rider's customer details.
        if path=="/api/rider/status" and method=="POST":
            status=str(body.get("status","")).strip()
            if status not in RIDER_STATES: fail("Choose Available, On delivery or Offline.")
            active=session.query(Order).filter(Order.rider_id==rider.id,Order.dispatch_status=="Dispatched",
                     Order.status.notin_(["cancelled","canceled","completed"])).count()
            if status=="Offline" and active: fail("Finish or decline your active deliveries before going Offline.",409)
            if status=="Available" and active: fail("You still have active deliveries — stay On delivery until they are done.",409)
            previous=rider.status;rider.status=status
            if previous!=status:
                notify_rider(session,"RIDER_STATUS_UPDATED","Partner availability changed",
                             f"{rider.name} is now {status} (set from the Adonai Delivery app).",rider,status=status)
            session.flush();return response({"ok":True,"rider":rider.to_dict()})
        match=re.fullmatch(r"/api/rider/orders/([^/]+)/decline",path)
        if match and method=="POST":
            order=session.query(Order).filter_by(id=match[1]).with_for_update().first()
            if not order or order.rider_id!=rider.id: fail("This delivery is not assigned to you.",404)
            if order.status in {"cancelled","canceled","completed"} or order.dispatch_status!="Dispatched" or order.payment_status!="paid":
                fail("This delivery is no longer active. Contact dispatch.",409)
            last=session.query(DeliveryEvent).filter_by(order_id=order.id,rider_id=rider.id).order_by(DeliveryEvent.created_at.desc(),DeliveryEvent.id.desc()).first()
            if last and last.stage in {"collected","arrived","delivered"}:
                fail("You already collected this parcel. Call dispatch instead of declining.",409)
            reason=str(body.get("reason","")).strip()
            reasons={"Too far for this trip","Vehicle problem","Customer unreachable","Finishing another job","Other"}
            if reason not in reasons: fail("Choose a reason for declining.")
            note=text(body.get("note",""),300,"Delivery note")
            detail=(reason+(": "+note if note else ""))[:500]
            event=add_event(session,order,rider,"declined",device,detail)
            # Return the job to the dispatch pool so another partner can take it.
            order.rider_id=None;order.rider_name="";order.dispatch_status="In Assembly";order.updated_at=now()
            others=session.query(Order).filter(Order.rider_id==rider.id,Order.id!=order.id,
                     Order.dispatch_status=="Dispatched",Order.status.notin_(["cancelled","canceled","completed"])).count()
            if not others and rider.status=="On delivery": rider.status="Available"
            notify_rider(session,"DELIVERY_DECLINED",f"Order {order.id}: declined",
                         f"{rider.name} declined {order.id} ({reason}). Reassign this delivery.",rider,
                         order_id=order.id,delivery_progress="declined",fulfillment_status="In Assembly",rider_status=rider.status)
            session.flush();return response({"ok":True,"event":event_dict(event),"rider":rider.to_dict()})
        match=re.fullmatch(r"/api/rider/orders/([^/]+)",path)
        if match and method=="GET":
            order=session.query(Order).filter_by(id=match[1]).first()
            if not order or order.rider_id!=rider.id: fail("This delivery is not assigned to you.",404)
            events=session.query(DeliveryEvent).filter_by(order_id=order.id,rider_id=rider.id).order_by(DeliveryEvent.created_at,DeliveryEvent.id).all()
            detail=order_brief(order,events[-1] if events else None)
            # Item names and quantities only — never unit costs, supplier data
            # or staff notes. A rider needs to know what to hand the customer.
            detail.update({
                "items":[{"name":i.name or "Item","qty":int(i.qty or 1),"unit_price":int(i.unit_price or 0),
                          "barcode_id":i.barcode_id or "","category":i.category or ""} for i in (order.items or [])],
                "timeline":[event_dict(e) for e in events],
                "subtotal":int(order.subtotal or 0),"payment_status":order.payment_status or "",
                "payment_method":order.tender_type or ""})
            return response({"ok":True,"order":detail})
        if path=="/api/rider/history" and method=="GET":
            rows=session.query(Order).filter(Order.rider_id==rider.id,Order.dispatch_status=="Completed").order_by(Order.updated_at.desc()).limit(60).all()
            history=[]
            for o in rows:
                done=session.query(DeliveryEvent).filter_by(order_id=o.id,rider_id=rider.id,stage="delivered").order_by(DeliveryEvent.created_at.desc()).first()
                history.append({"id":o.id,"customer_name":o.customer_name or "Customer","area":o.delivery_area or "",
                                "total":int(o.total or 0),"delivery_fee":int(o.delivery_fee or 0),
                                "received_by":done.received_by if done else "","delivered_at":iso(done.created_at) if done else iso(o.updated_at),
                                "note":done.note if done else ""})
            today=now().date();week=now()-timedelta(days=7)
            fees=lambda rows_:sum(int(o.delivery_fee or 0) for o in rows_)
            return response({"ok":True,"history":history,"rider":rider.to_dict(),
                             "earnings":{"all":fees(rows),"week":fees([o for o in rows if o.updated_at and o.updated_at>=week]),
                                         "today":fees([o for o in rows if o.updated_at and o.updated_at.date()==today]),
                                         "jobs":len(rows)},"server_time":iso(now())})
        if path=="/api/rider/demo/order" and method=="POST" and os.environ.get("ADONAI_DELIVERY_DEMO")=="1":
            # Local review only. Creates a fresh paid web delivery and puts it
            # through the exact same assignment path as the dispatch console.
            product=session.get(Product,"PRD-DEMO-1")
            if not product:
                product=Product(id="PRD-DEMO-1",sku="ADN-DEMO-1001",barcode_id="ADN-DEMO-1001",
                                name="Indigo Type III Trucker Jacket",brand="Adonai Vintage",demographic="Men",
                                category="Jackets",size="M",item_condition="PRE_LOVED",quantity_type="PRE_LOVED",
                                condition="Grade A",base_price=85000,total_transport_cost=0,selling_price=85000,
                                in_stock_count=1,slug="indigo-trucker-jacket-demo")
                session.add(product);session.flush()
            people=[("Amina Nakato","0772333444","Plot 5, Muyenga Road","Muyenga"),
                    ("Moses Ssempa","0755111222","Kabalagala, behind the market","Kabalagala"),
                    ("Grace Achieng","0701998877","Ntinda Complex, Shop 14","Ntinda"),
                    ("Peter Muwonge","0776111999","Bukoto Street, off Kisaasi Road","Bukoto")]
            name,phone,address,area=random.choice(people)
            oid="AT-D"+secrets.token_hex(3).upper();price=85000;fee=5000
            order=Order(id=oid,channel="web",status="processing",dispatch_status="In Assembly",
                        customer_name=name,customer_phone=phone,customer_address=address,delivery_type="boda",
                        delivery_area=area,delivery_fee=fee,delivery_notes="Call when you arrive at the gate.",
                        subtotal=price,total=price+fee,tender_type="momo",payment_status="paid",
                        payment_provider="momo",payment_channel="mtn",payment_reference="DEMO-"+oid,
                        paid_at=now(),cashier_name="Delivery demo",created_at=now(),updated_at=now())
            session.add(order)
            session.add(OrderItem(id="ODI-"+uuid.uuid4().hex[:12],order_id=oid,product_id=product.id,
                                  barcode_id=product.barcode_id,name=product.name,item_condition="PRE_LOVED",
                                  quantity_type="PRE_LOVED",unit_price=price,unit_cost=price//2,
                                  category="Jackets",qty=1,line_total=price))
            session.flush()
            assign(session,order,rider.id,"Delivery demo")
            session.flush()
            return response({"ok":True,"order_id":oid},201)
        if path=="/api/rider/duty/stop" and method=="POST":
            was_active=bool(device.sharing and device.duty_until and device.duty_until>now())
            device.sharing=False;device.duty_until=None
            if was_active:
                notify_rider(session, "RIDER_DUTY_STOPPED", "Rider duty stopped",
                             f"{rider.name} stopped sharing location.", rider)
            return response({"ok":True,"tracking":live_state(device)})
        if path=="/api/rider/duty/start" and method=="POST":
            if body.get("consent") is not True: fail("Explicit permission to share GPS during this duty is required.")
            if not policy_active(session,staff_required): fail("Location monitoring is not protected. Ask your dispatcher.",403,"TRACKING_PRIVACY_SETUP")
            was_active=bool(device.sharing and device.duty_until and device.duty_until>now())
            if not was_active: device.duty_until=now()+DUTY_LIFE
            device.sharing=True
            if not was_active:
                notify_rider(session, "RIDER_DUTY_STARTED", "Rider duty started",
                             f"{rider.name} started a duty. Location sharing is on until stopped or the duty expires.", rider)
            return response({"ok":True,"tracking":live_state(device),"duty_until":iso(device.duty_until)})
        if path=="/api/rider/location" and method=="POST":
            if not policy_active(session,staff_required): fail("Location monitoring is not protected.",403)
            if not device.sharing or not device.duty_until or device.duty_until<=now(): fail("GPS sharing is stopped or the 12-hour duty ended. Start a new duty explicitly.",409)
            for key,low,high in [("latitude",-90,90),("longitude",-180,180),("accuracy_m",0,20000)]:
                value=body.get(key)
                if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high: fail(f"Invalid {key}.")
            sequence=body.get("sequence")
            if isinstance(sequence,bool) or not isinstance(sequence,int) or not 0<sequence<2147483647: fail("Invalid location sequence.")
            try:
                fix_ms=body["fix_time_ms"]
                if isinstance(fix_ms,bool) or not isinstance(fix_ms,(int,float)) or not math.isfinite(fix_ms): raise ValueError()
                fixed=datetime.fromtimestamp(fix_ms/1000,timezone.utc).replace(tzinfo=None)
            except (KeyError,ValueError,TypeError,OverflowError,OSError): fail("Invalid GPS fix time.")
            if fixed>now()+timedelta(seconds=30) or fixed<now()-timedelta(minutes=5): fail("GPS fix is too old or in the future. Wait for a current phone fix.")
            if sequence<=device.sequence or (device.fix_at and fixed<device.fix_at): return response({"ok":True,"ignored":True})
            device.latitude=float(body["latitude"]);device.longitude=float(body["longitude"]);device.accuracy=float(body["accuracy_m"])
            device.fix_at=fixed;device.received_at=now();device.sequence=sequence;device.mock_location=body.get("mock") is True
            return response({"ok":True,"state":live_state(device)["state"]})
        match=re.fullmatch(r"/api/rider/orders/([^/]+)/progress",path)
        if match and method=="POST":
            order=session.query(Order).filter_by(id=match[1]).with_for_update().first()
            if not order or order.rider_id!=rider.id: fail("This delivery is not assigned to you.",404)
            stage=body.get("stage")
            if stage not in PROGRESS: fail("Unknown delivery update.")
            if order.status in {"cancelled","canceled"}: fail("This delivery was cancelled. Contact dispatch.",409)
            last=session.query(DeliveryEvent).filter_by(order_id=order.id,rider_id=rider.id).order_by(DeliveryEvent.created_at.desc(),DeliveryEvent.id.desc()).first()
            if last and last.stage==stage: return response({"ok":True,"event":event_dict(last),"order":order_brief(order,last)})
            if order.dispatch_status!="Dispatched" or order.payment_status!="paid": fail("This delivery is not active/paid. Contact dispatch.",409)
            if stage=="accepted" and not attendance_gate(session,rider)["checked_in_today"]:
                fail("Check in for today first: take your selfie and sign.",409,"ATTENDANCE_REQUIRED")
            previous=last.stage if last else "assigned"
            transitions={"assigned":{"accepted","issue"},"accepted":{"collected","issue"},"collected":{"arrived","delivered","issue"},"arrived":{"delivered","issue"},"issue":{"accepted","collected","arrived","delivered","issue"},"declined":{"accepted","issue"}}
            if stage not in transitions.get(previous,set()): fail(f"Cannot report {stage} before the preceding delivery step.",409)
            note=text(body.get("note",""),500,"Delivery note")
            received=text(body.get("received_by",""),100,"Recipient name",stage=="delivered")
            if stage=="issue" and not note: fail("Describe the delivery problem for dispatch.")
            event=add_event(session,order,rider,stage,device,note,received)
            previous_rider_status=rider.status
            if stage=="delivered":
                order.dispatch_status="Completed";order.status="completed";order.updated_at=now()
                if order.dispatched_at is None: order.dispatched_at=now()
                others=session.query(Order).filter(Order.rider_id==rider.id,Order.id!=order.id,Order.dispatch_status=="Dispatched",Order.status.notin_(["cancelled","completed"])).count()
                if not others and rider.status=="On delivery": rider.status="Available"
            progress_message=f"{rider.name} reported {stage}" + (f" · received by {received}" if received else "")
            if rider.status!=previous_rider_status: progress_message+=f" · now {rider.status}"
            notify_rider(session, "DELIVERY_PROGRESS", f"Delivery {order.id}: {stage}", progress_message, rider,
                         order_id=order.id, delivery_progress=stage, fulfillment_status=order.dispatch_status,
                         rider_status=rider.status)
            session.flush();return response({"ok":True,"event":event_dict(event),"order":order_brief(order,event)})
    return response({"ok":False,"error":"Dispatch route not found."},404)
