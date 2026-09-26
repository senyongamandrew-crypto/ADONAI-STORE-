"use client";
import { Plus, ShoppingBag } from "lucide-react";
import { placeholderImage } from "@/lib/photo";
import { unitPrice } from "@/lib/money";
import { Badge, Money } from "@/components/ui";
import type { Product } from "@/lib/db/types";

export function ProductCard({ product, onAdd }: { product: Product; onAdd: (p: Product) => void }) {
  const soldOut = product.stock <= 0;
  const low = !soldOut && product.stock <= product.min_stock;
  const price = unitPrice(product.price, product.discount_pct);
  const img = product.image_url || placeholderImage(product.sku + product.title, product.title);

  return (
    <article className={`tile group relative flex flex-col overflow-hidden transition ${soldOut ? "opacity-60" : "hover:-translate-y-0.5 hover:shadow-lg"}`}>
      <div className="relative aspect-square overflow-hidden bg-[#efe9df]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={img} alt={product.title} loading="lazy" className={`h-full w-full object-cover ${soldOut ? "grayscale" : ""}`} />
        <div className="absolute left-2 top-2 flex flex-col items-start gap-1">
          {product.discount_pct > 0 && !soldOut && <Badge tone="bad">-{product.discount_pct}%</Badge>}
          {soldOut && <Badge tone="bad">Sold out</Badge>}
          {low && <Badge tone="warn">Only {product.stock} left</Badge>}
        </div>
        <span className="absolute bottom-2 right-2 rounded-md bg-white/85 px-1.5 py-0.5 font-mono text-[10px] text-ink-700">{product.sku}</span>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="line-clamp-2 font-sans text-sm font-medium leading-snug tracking-card">{product.title}</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="brass">{product.condition}</Badge>
          <Badge>{product.size}</Badge>
        </div>
        <div className="mt-auto flex items-end justify-between gap-2 pt-1">
          <div>
            {product.discount_pct > 0 && <div className="text-xs text-ink-600 line-through"><Money value={product.price} /></div>}
            <div className="text-lg font-bold tabular-nums"><Money value={price} /></div>
          </div>
          <button
            onClick={() => onAdd(product)}
            disabled={soldOut}
            className="btn-primary px-3 py-2 text-xs"
            aria-label={soldOut ? `${product.title} is sold out` : `Add ${product.title} to cart`}
          >
            {soldOut ? <ShoppingBag size={15} /> : <Plus size={15} />} Add
          </button>
        </div>
      </div>
    </article>
  );
}
