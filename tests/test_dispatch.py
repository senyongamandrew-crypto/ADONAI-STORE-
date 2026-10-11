"""Consent, privacy, SQL persistence and dispatch regressions. Temporary DB only."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
_TEMP=tempfile.TemporaryDirectory(prefix="adonai-dispatch-tests-")
os.environ.update({"DATABASE_URL":"sqlite:///"+str(Path(_TEMP.name)/"dispatch.db"),"ADONAI_REQUIRE_STAFF_AUTH":"0","ADONAI_RATE_LIMIT_DISABLED":"1","ADONAI_SEED_DEMO_CATALOG":"0","ADONAI_SEED_DEMO_USERS":"0"})
import database
database.IS_POSTGRES=False
from database import Base,engine,get_db
from models import Rider,RiderDevice,RiderPairing,DeliveryEvent,Order,OrderItem,Product,LedgerEntry,PosAccessKey,PosAccessSession,StoreSetting,User,NotificationEvent
import access_control
import api
import dispatch

ADMIN_TOKEN="A"*43
HEADERS={"X-Pos-Access":ADMIN_TOKEN}

class DispatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): Base.metadata.create_all(engine)
    def setUp(self):
        with get_db() as s:
            for model in [DeliveryEvent,RiderPairing,RiderDevice,OrderItem,Order,Rider,Product,LedgerEntry,PosAccessSession,PosAccessKey,StoreSetting,User,NotificationEvent]:s.query(model).delete(synchronize_session=False)
            s.add(Rider(id="R1",name="Authorized rider",phone="+256700111222",vehicle="Motorbike",zone="Kampala",archived=False))
            s.add(Rider(id="R2",name="Other rider",phone="+256700111333",archived=False))
            s.add(Product(id="P1",sku="S1",barcode_id="BC-1",name="Saved garment",demographic="Women",category="Dress",cost_price=5000,selling_price=20000,base_price=20000,in_stock_count=7))
            s.add(LedgerEntry(id="L1",kind="sale",amount=25000,ref_id="O1"))
            for identity,payment,stage,delivery in [("O1","paid","In Assembly","boda"),("O2","paid","In Assembly","boda"),("UNPAID","unpaid","In Assembly","boda"),("PICKUP","paid","In Assembly","pickup"),("CLOSED","paid","Completed","boda"),("NEW","paid","Unfulfilled","boda")]:
                order=Order(id=identity,channel="web",status="completed" if stage=="Completed" else "processing",dispatch_status=stage,payment_status=payment,customer_name="Buyer <script>",customer_phone="+256700222333",customer_address="Kibuli, Kampala",subtotal=20000,total=25000,delivery_fee=5000,delivery_type=delivery)
                order.items=[OrderItem(id="IT-"+identity,product_id="P1",name="Historical dress",qty=1,unit_price=20000,unit_cost=5000,line_total=20000)]
                s.add(order)
    def protect(self):
        with get_db() as s:
            s.add(StoreSetting(key=access_control.POLICY_KEY,value='["orders"]'))
            s.add(PosAccessKey(id="OWNER",name="Owner",password_hash="unused",is_admin=True,enabled=True,version=1,areas="[]"))
            s.add(PosAccessSession(token_hash=hashlib.sha256(ADMIN_TOKEN.encode()).hexdigest(),key_id="OWNER",key_version=1,expires_at=datetime.utcnow()+timedelta(hours=1)))
    def raw(self,method,path,body=None,headers=None,query=None):
        return api.handle_api_request(method,path,query or {},json.dumps(body).encode() if body is not None else b"",headers or {},"dispatch-test")
    def call(self,method,path,body=None,headers=None,status=200):
        result=self.raw(method,path,body,headers);self.assertEqual(result[0],status,result[2]);return json.loads(result[2])
    def paired(self,rider="R1"):
        code=self.call("POST",f"/api/dispatch/riders/{rider}/pair",{},HEADERS,201)["code"]
        data=self.call("POST","/api/rider/pair",{"code":code,"device_label":"Authorized Android phone"},status=201)
        return {"Authorization":"Bearer "+data["session_token"]},data
    def start(self,headers):return self.call("POST","/api/rider/duty/start",{"consent":True},headers)
    def gps(self,headers,sequence=1,**extra):
        return self.raw("POST","/api/rider/location",{"latitude":0.32,"longitude":32.6,"accuracy_m":12,"fix_time_ms":datetime.now(timezone.utc).timestamp()*1000,"sequence":sequence,**extra},headers)
    def test_roster_is_sql_saved_and_survives_sync_without_exposing_locations(self):
        saved=self.call("POST","/api/riders",{"name":"New partner","phone":"+256700000000","vehicle":"Van","zone":"Central","plate":"UBX 123"},status=201)["rider"]
        self.call("PATCH","/api/riders/"+saved["id"],{"zone":"Makindye"})
        with get_db() as s:self.assertEqual(s.get(Rider,saved["id"]).zone,"Makindye")
        rows=self.call("POST","/api/sync/pull",{})["riders"];self.assertEqual(len(rows),3);self.assertNotIn("tracking",json.dumps(rows));self.assertNotIn("token_hash",json.dumps(rows))
        board=self.call("GET","/api/dispatch/board");self.assertFalse(board["gps_access"]);self.assertEqual(board["riders"][0]["tracking"]["state"],"protected")
        self.call("DELETE","/api/riders/"+saved["id"])
        with get_db() as s:self.assertTrue(s.get(Rider,saved["id"]).archived)
    def test_gps_requires_deliberate_private_access_without_gating_register(self):
        self.call("POST","/api/dispatch/riders/R1/pair",{},status=403)
        self.protect();self.call("GET","/api/dispatch/board",status=403)
        self.assertTrue(self.call("GET","/api/dispatch/board",headers=HEADERS)["gps_access"])
        self.assertEqual(self.raw("POST","/api/inventory-locks/acquire",{})[0],400,"open checkout reservation must not become an Orders password operation")
    def test_single_use_pairing_repair_revokes_old_device_and_never_auto_starts_gps(self):
        self.protect();code=self.call("POST","/api/dispatch/riders/R1/pair",{},HEADERS,201)["code"]
        data=self.call("POST","/api/rider/pair",{"code":code,"device_label":"Phone 1"},status=201)
        token=data["session_token"];self.assertEqual(len(token),43)
        self.call("POST","/api/rider/pair",{"code":code,"device_label":"Replay"},status=403)
        with get_db() as s:
            device=s.query(RiderDevice).one();self.assertNotEqual(device.token_hash,token);self.assertFalse(device.sharing);self.assertIsNone(device.latitude);self.assertEqual(s.query(RiderPairing).count(),0)
        old={"Authorization":"Bearer "+token};self.call("GET","/api/rider/me",headers=old)
        newer,_=self.paired();self.call("GET","/api/rider/me",headers=old,status=401);self.call("GET","/api/rider/me",headers=newer)
    def test_pairing_expiry_device_revocation_and_credentials_not_in_query(self):
        self.protect();code=self.call("POST","/api/dispatch/riders/R1/pair",{},HEADERS,201)["code"]
        with get_db() as s:s.get(RiderPairing,"R1").expires_at=datetime.utcnow()-timedelta(seconds=1)
        self.call("POST","/api/rider/pair",{"code":code,"device_label":"Phone"},status=403)
        headers,data=self.paired();self.assertEqual(self.raw("GET","/api/rider/me",query={"token":data["session_token"]})[0],401)
        self.call("POST","/api/dispatch/riders/R1/revoke",{},HEADERS);self.call("GET","/api/rider/me",headers=headers,status=401)
    def test_consent_current_gps_freshness_accuracy_replay_and_no_business_mutation(self):
        self.protect();headers,_=self.paired()
        self.assertEqual(self.gps(headers)[0],409);self.call("POST","/api/rider/duty/start",{},headers,status=400);self.start(headers)
        self.assertEqual(self.gps(headers)[0],200)
        self.assertEqual(self.gps(headers,sequence=1,latitude=0.99)[0],200)
        self.assertEqual(self.gps(headers,sequence=2,latitude=91)[0],400)
        self.assertEqual(self.gps(headers,sequence=2,accuracy_m=-1)[0],400)
        self.assertEqual(self.gps(headers,sequence=2,fix_time_ms=0)[0],400)
        board=self.call("GET","/api/dispatch/board",headers=HEADERS);tracking=next(r["tracking"] for r in board["riders"] if r["id"]=="R1")
        self.assertEqual(tracking["state"],"live");self.assertEqual(tracking["point"]["latitude"],0.32);self.assertEqual(tracking["point"]["accuracy_m"],12)
        with mock.patch("dispatch.now",return_value=datetime.utcnow()+timedelta(minutes=2)):
            old=self.call("GET","/api/dispatch/board",headers=HEADERS);self.assertEqual(next(r for r in old["riders"] if r["id"]=="R1")["tracking"]["state"],"stale")
        with get_db() as s:self.assertEqual(s.get(Product,"P1").in_stock_count,7);self.assertEqual(s.query(LedgerEntry).count(),1);self.assertEqual(s.get(Order,"O1").payment_status,"paid")
        self.call("POST","/api/rider/duty/stop",{},headers);self.assertEqual(self.gps(headers,sequence=3)[0],409)
        self.assertEqual(self.call("GET","/api/rider/me",headers=headers)["tracking"]["state"],"paused")
    def test_duty_timeout_simulated_fix_and_bounded_latest_point_retention(self):
        self.protect();headers,_=self.paired();self.start(headers);self.assertEqual(self.gps(headers,mock=True)[0],200)
        self.assertEqual(self.call("GET","/api/rider/me",headers=headers)["tracking"]["state"],"simulated")
        with get_db() as s:s.query(RiderDevice).one().duty_until=datetime.utcnow()-timedelta(seconds=1)
        self.assertEqual(self.gps(headers,sequence=2)[0],409)
        with mock.patch("dispatch.now",return_value=datetime.utcnow()+timedelta(hours=25)):
            self.call("GET","/api/dispatch/board",headers=HEADERS)
        with get_db() as s:self.assertIsNone(s.query(RiderDevice).one().latitude)
    def test_paid_prepared_delivery_assignment_idempotency_and_protected_costs(self):
        self.protect()
        board=self.call("GET","/api/dispatch/board",headers=HEADERS);self.assertEqual({o["id"] for o in board["orders"]},{"O1","O2"})
        for identity in ["UNPAID","PICKUP","CLOSED","NEW"]:self.call("POST",f"/api/dispatch/orders/{identity}/assign",{"rider_id":"R1"},HEADERS,409)
        self.call("POST","/api/dispatch/orders/O1/assign",{"rider_id":"MISSING"},HEADERS,404)
        self.call("POST","/api/dispatch/orders/O1/assign",{"rider_id":"R1"},HEADERS)
        self.call("POST","/api/dispatch/orders/O1/assign",{"rider_id":"R1"},HEADERS)
        with get_db() as s:
            self.assertEqual(s.get(Order,"O1").rider_name,"Authorized rider");self.assertEqual(s.get(Order,"O1").dispatch_status,"Dispatched");self.assertEqual(s.get(Rider,"R1").status,"On delivery");self.assertEqual(s.query(DeliveryEvent).count(),1)
        self.call("DELETE","/api/riders/R1",headers=HEADERS,status=409)
        self.call("PATCH","/api/riders/R1",{"status":"Offline"},HEADERS,409)
        self.call("POST","/api/dispatch/orders/O1/assign",{"rider_id":"R2"},HEADERS)
        with get_db() as s:self.assertEqual(s.get(Rider,"R1").status,"Available")
    def test_rider_only_own_orders_progress_recipient_delivery_and_reassignment(self):
        self.protect();first,_=self.paired("R1");second,_=self.paired("R2")
        self.call("POST","/api/dispatch/orders/O1/assign",{"rider_id":"R1"},HEADERS)
        self.call("POST","/api/dispatch/orders/O2/assign",{"rider_id":"R2"},HEADERS)
        mine=self.call("GET","/api/rider/me",headers=first);self.assertEqual([o["id"] for o in mine["orders"]],["O1"]);self.assertNotIn("unit_cost",json.dumps(mine))
        self.call("POST","/api/rider/orders/O2/progress",{"stage":"accepted"},first,404)
        self.call("POST","/api/rider/orders/O1/progress",{"stage":"delivered","received_by":"Sarah"},first,409)
        for stage in ["accepted","collected","arrived"]:self.call("POST","/api/rider/orders/O1/progress",{"stage":stage},first)
        self.call("POST","/api/rider/orders/O1/progress",{"stage":"delivered"},first,400)
        done=self.call("POST","/api/rider/orders/O1/progress",{"stage":"delivered","received_by":"Sarah","note":"Handed to recipient at gate"},first)
        self.assertEqual(done["event"]["received_by"],"Sarah")
        self.call("POST","/api/rider/orders/O1/progress",{"stage":"delivered","received_by":"Sarah"},first)
        with get_db() as s:
            self.assertEqual(s.get(Order,"O1").status,"completed");self.assertEqual(s.get(Order,"O1").payment_status,"paid");self.assertEqual(s.get(Product,"P1").in_stock_count,7);self.assertEqual(s.query(LedgerEntry).count(),1)
            self.assertEqual(s.query(DeliveryEvent).filter_by(order_id="O1",stage="delivered").count(),1)
        self.call("POST","/api/dispatch/orders/O2/assign",{"rider_id":"R1"},HEADERS)
        self.call("POST","/api/rider/orders/O2/progress",{"stage":"accepted"},second,404)
    def test_setup_and_session_relock_clear_private_location_feed(self):
        self.protect();headers,_=self.paired();self.start(headers);self.gps(headers)
        with get_db() as s:s.query(PosAccessSession).delete()
        self.call("GET","/api/dispatch/board",headers=HEADERS,status=403)
        with get_db() as s:s.get(StoreSetting,access_control.POLICY_KEY).value='[]'
        board=self.call("GET","/api/dispatch/board");self.assertFalse(board["gps_access"]);self.assertNotIn("latitude",json.dumps(board));self.assertEqual(self.gps(headers,sequence=2)[0],403)
    def test_orders_only_unlock_redacts_financial_costs_and_legacy_assignment_emits_one_bell(self):
        self.protect()
        scoped="S"*43
        with get_db() as s:
            s.get(StoreSetting,access_control.POLICY_KEY).value='["orders","finance","stock"]'
            s.add(PosAccessKey(id="DISPATCHER",name="Dispatcher",password_hash="unused",is_admin=False,enabled=True,version=1,areas='["orders"]'))
            s.add(PosAccessSession(token_hash=hashlib.sha256(scoped.encode()).hexdigest(),key_id="DISPATCHER",key_version=1,expires_at=datetime.utcnow()+timedelta(hours=1)))
        scoped_headers={"X-Pos-Access":scoped}
        order=self.call("POST","/api/dispatch/orders/O1/assign",{"rider_id":"R1"},scoped_headers)["order"]
        self.assertNotIn("unit_cost",json.dumps(order));self.assertNotIn("cost_total",order)
        self.call("PATCH","/api/orders/O2",{"rider_id":"R2","dispatch_status":"Cancelled"},scoped_headers,400)
        self.call("PATCH","/api/orders/O2",{"rider_id":"R2","dispatch_status":"Dispatched"},scoped_headers)
        self.call("PATCH","/api/orders/O2",{"rider_id":"R2","dispatch_status":"Dispatched"},scoped_headers)
        with get_db() as s:
            self.assertEqual(s.get(Order,"O2").rider_id,"R2")
            self.assertEqual(s.get(Order,"O2").payment_status,"paid")
            self.assertEqual(s.query(DeliveryEvent).filter_by(order_id="O2").count(),1)
            self.assertEqual(sum(json.loads(event.payload_json).get("order_id")=="O2" for event in s.query(NotificationEvent).all()),1)
    def test_staff_roles_and_disabled_identity_cannot_bypass_private_gps(self):
        with get_db() as s:
            s.add(User(id="MANAGER",name="Manager",role="manager",pin_hash="unused",active=True))
            s.add(User(id="CASHIER",name="Cashier",role="cashier",pin_hash="unused",active=True))
        with mock.patch("api.staff_auth_required",return_value=True):
            for role,identity,expected in [("manager","MANAGER",True),("cashier","CASHIER",False)]:
                with mock.patch("api.is_authenticated_staff",return_value=(True,{"id":identity,"role":role})):
                    self.assertEqual(self.call("GET","/api/dispatch/board")["gps_access"],expected)
            with get_db() as s:s.get(User,"MANAGER").active=False
            with mock.patch("api.is_authenticated_staff",return_value=(True,{"id":"MANAGER","role":"manager"})):
                self.assertFalse(self.call("GET","/api/dispatch/board")["gps_access"])
                self.call("POST","/api/dispatch/riders/R1/pair",{},status=403)
            with mock.patch("api.is_authenticated_staff",return_value=(True,{"id":"RIDER","role":"rider"})):
                self.call("GET","/api/dispatch/board",status=401)
    def test_json_responses_private_no_store_and_default_sync_has_no_device_secrets(self):
        self.protect();headers,data=self.paired();self.start(headers);self.gps(headers)
        response=self.raw("GET","/api/dispatch/board",headers=HEADERS);self.assertEqual(response.headers["Cache-Control"],"private, no-store");self.assertEqual(response.headers["Referrer-Policy"],"no-referrer")
        payload=self.call("POST","/api/sync/pull",{},HEADERS);serialized=json.dumps(payload)
        self.assertNotIn(data["session_token"],serialized);self.assertNotIn("rider_devices",serialized);self.assertNotIn("latitude",serialized)

    def test_rider_whatsapp_after_commit_manual_fallback_and_no_rider_dispatch(self):
        self.protect()
        sent=[]
        class Reply:
            def __enter__(inner): return inner
            def __exit__(inner,*args): return False
            def read(inner): return b'{"messages":[{"id":"wamid.TEST"}]}'
        def fake_open(request,timeout):
            self.assertEqual(request.headers["Authorization"],"Bearer SECRET-TOKEN");self.assertLessEqual(timeout,10)
            self.assertIn("/PHONEID/messages",request.full_url);sent.append(json.loads(request.data));return Reply()
        configured={"WHATSAPP_ACCESS_TOKEN":"SECRET-TOKEN","WHATSAPP_PHONE_NUMBER_ID":"PHONEID"}
        # Rider-less dispatch of a paid delivery is refused and does not change the order.
        self.call("PATCH","/api/orders/O1",{"dispatch_status":"Dispatched"},HEADERS,409)
        with get_db() as s:self.assertEqual(s.get(Order,"O1").dispatch_status,"In Assembly");self.assertIsNone(s.get(Order,"O1").rider_id)
        with mock.patch.dict(os.environ,configured,clear=False),mock.patch("dispatch.urllib.request.urlopen",side_effect=fake_open):
            result=self.call("POST","/api/dispatch/orders/O1/assign",{"rider_id":"R1"},HEADERS)
        self.assertEqual(result["rider_notice"]["status"],"sent");self.assertIsNone(result["rider_notice"]["wa_link"])
        self.assertEqual(len(sent),1);self.assertEqual(sent[0]["to"],"256700111222");self.assertEqual(sent[0]["type"],"text")
        body=sent[0]["text"]["body"];self.assertIn("O1",body);self.assertIn("Kibuli, Kampala",body);self.assertIn("UGX 25,000",body);self.assertNotIn("SECRET-TOKEN",body)
        with get_db() as s:self.assertIn("WhatsApp to rider: sent",s.query(DeliveryEvent).filter_by(order_id="O1").one().note)
        # Without server credentials the job still saves; staff get a tap-to-message link instead of a silent failure.
        with mock.patch.dict(os.environ,{"WHATSAPP_ACCESS_TOKEN":"","WHATSAPP_PHONE_NUMBER_ID":""}):
            failed=self.call("POST","/api/dispatch/orders/O2/assign",{"rider_id":"R2"},HEADERS)
        self.assertEqual(failed["rider_notice"]["status"],"not_configured")
        self.assertTrue(failed["rider_notice"]["wa_link"].startswith("https://wa.me/256700111333?text="))
        with get_db() as s:
            self.assertEqual(s.get(Order,"O2").dispatch_status,"Dispatched");self.assertIn("not sent",s.query(DeliveryEvent).filter_by(order_id="O2").one().note)
        board=self.call("GET","/api/dispatch/board",headers=HEADERS);links={o["id"]:o.get("rider_wa_link") for o in board["orders"]}
        self.assertIn("https://wa.me/256700111222?text=",links["O1"]);self.assertIn("Deliver%20to",links["O1"]);self.assertIn("https://wa.me/256700111333?text=",links["O2"])
        # Network/API failure: the assignment is kept, the error never leaks credentials.
        import urllib.error
        with mock.patch.dict(os.environ,configured),mock.patch("dispatch.urllib.request.urlopen",side_effect=urllib.error.URLError("boom SECRET-TOKEN")):
            self.call("POST","/api/dispatch/orders/O1/assign",{"rider_id":"R2"},HEADERS)
        with get_db() as s:self.assertEqual(s.get(Order,"O1").rider_id,"R2")
        self.assertNotIn("SECRET-TOKEN",json.dumps(self.call("GET","/api/dispatch/board",headers=HEADERS)))
        # Template mode for business-initiated messages; a rejected send is reported, not raised.
        template_configured={**configured,"WHATSAPP_RIDER_TEMPLATE":"rider_job"}
        with mock.patch.dict(os.environ,template_configured),mock.patch("dispatch.urllib.request.urlopen",side_effect=fake_open):
            self.call("POST","/api/dispatch/orders/O1/assign",{"rider_id":"R1"},HEADERS)
        self.assertEqual(sent[-1]["type"],"template");self.assertEqual(sent[-1]["template"]["name"],"rider_job")
        self.assertEqual(dispatch.whatsapp_number("0700 111 222"),"256700111222");self.assertEqual(dispatch.whatsapp_number("+256 700-111-222"),"256700111222");self.assertEqual(dispatch.whatsapp_number("12"),"")
    def test_dispatched_without_rider_is_refused_for_delivery_but_pickup_is_unchanged(self):
        self.protect()
        self.call("PATCH","/api/orders/O2",{"dispatch_status":"Dispatched"},HEADERS,409)
        with get_db() as s:self.assertEqual(s.get(Order,"O2").dispatch_status,"In Assembly")
        self.call("PATCH","/api/orders/PICKUP",{"dispatch_status":"Ready for Pickup"},HEADERS)
        with get_db() as s:self.assertEqual(s.get(Order,"PICKUP").dispatch_status,"Ready for Pickup")
        self.call("PATCH","/api/orders/O2",{"dispatch_status":"Dispatched","rider_id":"R1"},HEADERS)
        with get_db() as s:self.assertEqual(s.get(Order,"O2").rider_id,"R1")
        self.assertTrue(self.call("GET","/api/dispatch/board",headers=HEADERS)["orders"])

if __name__=="__main__":unittest.main()
