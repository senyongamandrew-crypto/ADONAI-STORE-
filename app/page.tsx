import { getCurrentUser } from "@/lib/auth";
import { db, dataMode } from "@/lib/db";
import { Showroom } from "@/components/Showroom";
import { TopBar } from "@/components/TopBar";
import { BrandIntro, DeliveryBands } from "@/components/BrandStory";
import { STORE } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function ShowroomPage() {
  const [products, user] = await Promise.all([db().listProducts({}), getCurrentUser()]);
  return (
    <>
      <TopBar user={user} mode={dataMode()} />
      <BrandIntro />
      <Showroom initial={{ products, user }} />
      <DeliveryBands />

      <footer className="no-print bg-sand-50">
        <div className="mx-auto grid max-w-[1400px] gap-8 px-5 py-12 text-ink-700 sm:px-8 md:grid-cols-3">
          <div>
            <p className="font-display text-xl font-bold tracking-editorial text-ink-900">{STORE.name}</p>
            <p className="mt-3 text-[15px] leading-[1.6]">{STORE.address}</p>
            <p className="text-[15px] leading-[1.6]">{STORE.hours}</p>
            <p className="text-[15px] leading-[1.6]">{STORE.phone}</p>
          </div>
          <div>
            <p className="card-heading">Ordering</p>
            <p className="mt-3 max-w-sm text-[15px] leading-[1.6]">
              Send your basket to WhatsApp. We check the rail, tell you it is still there, and you
              pay by MTN MoMo, Airtel Money or cash in store.
            </p>
          </div>
          <div>
            <p className="card-heading">Stock</p>
            <p className="mt-3 max-w-sm text-[15px] leading-[1.6]">
              One of each, and the counter works off the same numbers this page shows. Sold out here
              means it has already gone.
            </p>
          </div>
        </div>
      </footer>
    </>
  );
}
