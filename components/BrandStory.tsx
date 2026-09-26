import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";
import { MapPin, Truck } from "lucide-react";
import { DELIVERY, STORE } from "@/lib/config";

/**
 * Uses the first real photo found in /public/brand, otherwise renders an empty
 * frame. No stock imagery is ever substituted — the container is already sized
 * for an actual shoot (see public/brand/README.md).
 */
function brandPhoto(): string | null {
  for (const file of ["intro.jpg", "intro.jpeg", "intro.png", "intro.webp"]) {
    if (existsSync(path.join(process.cwd(), "public", "brand", file))) return `/brand/${file}`;
  }
  return null;
}

/** Brand story + hero frame. Sits above the rail. */
export function BrandIntro() {
  const photo = brandPhoto();

  return (
    <>
      <section className="mx-auto max-w-[1400px] px-5 pb-14 pt-10 sm:px-8">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-center">
          <div className="max-w-xl">
            <p className="mb-4 inline-flex items-center gap-2 rounded-pill border border-clay-600/20 bg-clay-50 px-3 py-1 text-[11px] font-bold uppercase tracking-card text-clay-600">
              <span className="h-1.5 w-1.5 rounded-pill bg-olive-500" aria-hidden />
              {STORE.name} · {STORE.address.split(",").slice(-2).join(",").trim()}
            </p>
            <h1 className="text-[2.4rem] leading-[1.08] sm:text-[3.4rem]">
              Second-hand, chosen one piece at a time.
            </h1>
            <p className="mt-5 text-[17px] leading-[1.65] text-ink-800">
              We buy bales, then we go through them. Most of what comes out never makes it to the
              rail. The rest is washed, steam-pressed and hung to dry before anyone photographs it.
            </p>
            <p className="mt-4 text-[17px] leading-[1.65] text-ink-800">
              No stock photos and no filters. Every picture here is the actual piece you will
              receive, shot in daylight against a plain wall — front, back, faults included. If
              there is a mark on the cuff, you will see it before you order.
            </p>
            <p className="mt-4 text-[17px] leading-[1.65] text-ink-800">
              Sizes are measured, not guessed. Prices are in shillings, and they do not move after
              you have ordered.
            </p>
            <ul className="mt-7 flex flex-wrap gap-2 text-sm">
              {["One of each", "Washed and pressed in store", "Priced in UGX"].map((t) => (
                <li key={t} className="inline-flex items-center gap-1.5 rounded-pill border border-olive-500/25 bg-olive-50 px-3 py-1 font-semibold text-olive-700">
                  {t}
                </li>
              ))}
            </ul>
          </div>

          {/* Image container — sized and cropped for real inventory photography. */}
          <figure className="m-0">
            {/* Arch-topped frame — the signature shape of this design. */}
            <div className="aspect-[4/5] w-full overflow-hidden rounded-t-[14rem] rounded-b-card border border-clay-700/10 bg-sand-200 shadow-lift">
              {photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo} alt="A piece from the current rail, photographed in store" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <span className="font-display text-2xl text-clay-700/40">{STORE.name}</span>
                  <span className="text-xs uppercase tracking-card text-clay-700/35">Photography goes here</span>
                </div>
              )}
            </div>
            <figcaption className="mt-3 text-sm text-ink-600">
              Shot in store. What you see is what arrives.
            </figcaption>
          </figure>
        </div>
      </section>
    </>
  );
}

/** Delivery bands. Sits below the rail, above the footer. */
export function DeliveryBands() {
  return (
    <>
      <section className="border-y border-clay-700/10 bg-sand-100">
        <div className="mx-auto max-w-[1400px] px-5 py-12 sm:px-8">
          <h2 className="text-3xl sm:text-[2.5rem] sm:leading-[1.1]">
            Getting it to you
            <span className="mt-2 block h-1.5 w-16 rounded-pill bg-olive-400" aria-hidden />
          </h2>
          <p className="mt-3 max-w-2xl text-[17px] leading-[1.65] text-ink-800">
            Three regions, three honest timelines. We confirm the piece is still on the rail before
            anything is sent.
          </p>

          <div className="mt-8 grid gap-6 md:grid-cols-3">
            {DELIVERY.map((zone, i) => (
              <article key={zone.region} className="panel text-left">
                <span className="mb-5 inline-flex rounded-pill bg-clay-50 p-2.5 text-clay-600">
                  {i === 0 ? <MapPin size={22} strokeWidth={1.5} aria-hidden /> : <Truck size={22} strokeWidth={1.5} aria-hidden />}
                </span>
                <h3 className="card-heading">{zone.region}</h3>
                <p className="mt-3 text-[15px] font-semibold text-ink-900">{zone.eta}</p>
                <p className="mt-1.5 text-[15px] leading-[1.6] text-ink-700">{zone.towns}</p>
                <p className="mt-3 text-[15px] leading-[1.6] text-ink-600">{zone.detail}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

/** Both, in order — for pages that do not interleave the catalog. */
export function BrandStory() {
  return (
    <>
      <BrandIntro />
      <DeliveryBands />
    </>
  );
}
