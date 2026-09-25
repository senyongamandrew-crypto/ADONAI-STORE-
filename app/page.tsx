import { getCurrentUser } from "@/lib/auth";
import { db, dataMode } from "@/lib/db";
import { Showroom } from "@/components/Showroom";
import { TopBar } from "@/components/TopBar";
import { STORE } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function ShowroomPage() {
  const [products, user] = await Promise.all([db().listProducts({}), getCurrentUser()]);
  return (
    <>
      <TopBar user={user} mode={dataMode()} />
      <Showroom initial={{ products, user }} />
      <footer className="no-print border-t border-ink-900/10 bg-white">
        <div className="mx-auto grid max-w-[1400px] gap-4 px-3 py-6 text-sm text-ink-600 sm:grid-cols-3 sm:px-5">
          <div>
            <p className="font-display text-base font-bold text-ink-900">{STORE.name}</p>
            <p>{STORE.address}</p>
            <p>{STORE.hours}</p>
          </div>
          <div>
            <p className="font-semibold text-ink-900">Ordering</p>
            <p>Orders are sent to WhatsApp and confirmed by the shop before payment (MTN MoMo, Airtel Money or cash in store).</p>
          </div>
          <div>
            <p className="font-semibold text-ink-900">Stock</p>
            <p>Quantities mirror the counter terminal — if it says sold out here, it is off the rail.</p>
          </div>
        </div>
      </footer>
    </>
  );
}
