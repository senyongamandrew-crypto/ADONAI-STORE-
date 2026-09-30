"use client";

import React, { useState, useEffect, useCallback, useId } from "react";
import Image from "next/image";

/* ============================================================================
   Types & Interfaces
   ============================================================================ */

export interface ProductPhoto {
  id: string;
  url: string;
  alt: string;
  label: "Front" | "Back" | "Tag" | "Fabric" | "Detail" | string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  brand: string;
  category: string;
  demographic: "Men" | "Women" | "Unisex" | "Kids" | string;
  size: string;
  color: string;
  conditionGrade: "Grade A — Excellent" | "Grade B — Good" | "Grade C — Fair" | string;
  sellingPrice: number; // in UGX (e.g., 45000)
  costPrice: number; // original reference/cost price (e.g., 65000)
  rating: number; // 0.0 to 5.0
  reviewCount: number;
  inStockCount: number;
  description: string;
  photos: ProductPhoto[];
  material?: string;
  origin?: string;
}

export interface ProductCardProps {
  product: Product;
  onAddToCart?: (product: Product) => void;
  onOpenDetails?: (product: Product) => void;
  className?: string;
  priorityImage?: boolean;
}

/* ============================================================================
   Helper Utilities
   ============================================================================ */

/** Format currency into standard Ugandan Shillings (e.g., UGX 45,000) */
export const formatUGX = (amount: number): string => {
  return `UGX ${Math.round(amount).toLocaleString("en-UG")}`;
};

/** Calculate discount % according to Adonai Store specification */
export const calculateDiscount = (sellingPrice: number, costPrice: number): number => {
  if (!sellingPrice || !costPrice || costPrice <= sellingPrice) return 0;
  const pct = Math.round(((costPrice - sellingPrice) / costPrice) * 100);
  return pct > 0 ? pct : 0;
};

/* ============================================================================
   Subcomponents
   ============================================================================ */

interface StarRatingProps {
  rating: number;
  reviewCount: number;
}

const StarRating: React.FC<StarRatingProps> = ({ rating, reviewCount }) => {
  const fullStars = Math.floor(rating);
  const hasHalfStar = rating % 1 >= 0.4 && rating % 1 <= 0.8;

  return (
    <div className="flex items-center gap-1.5 text-xs text-stone-600" aria-label={`Rated ${rating} out of 5 stars with ${reviewCount} reviews`}>
      <div className="flex items-center text-amber-500">
        {[...Array(5)].map((_, i) => {
          if (i < fullStars) {
            return (
              <svg key={i} className="w-3.5 h-3.5 fill-current" viewBox="0 0 20 20">
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
            );
          }
          if (i === fullStars && hasHalfStar) {
            return (
              <svg key={i} className="w-3.5 h-3.5 text-amber-500" viewBox="0 0 20 20" fill="currentColor">
                <defs>
                  <linearGradient id={`half-star-${i}`}>
                    <stop offset="50%" stopColor="currentColor" />
                    <stop offset="50%" stopColor="#E7E5E4" stopOpacity="1" />
                  </linearGradient>
                </defs>
                <path fill={`url(#half-star-${i})`} d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
              </svg>
            );
          }
          return (
            <svg key={i} className="w-3.5 h-3.5 text-stone-300 fill-current" viewBox="0 0 20 20">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
          );
        })}
      </div>
      <span className="font-medium text-stone-700">{rating.toFixed(1)}</span>
      <span className="text-stone-400">({reviewCount})</span>
    </div>
  );
};

/* ============================================================================
   Product Detail Modal Component
   ============================================================================ */

interface ProductDetailModalProps {
  product: Product;
  isOpen: boolean;
  onClose: () => void;
  onAddToCart?: (product: Product) => void;
}

export const ProductDetailModal: React.FC<ProductDetailModalProps> = ({
  product,
  isOpen,
  onClose,
  onAddToCart,
}) => {
  const [activePhotoIndex, setActivePhotoIndex] = useState<number>(0);
  const [isAdded, setIsAdded] = useState(false);
  const titleId = useId();

  // Reset active photo when a new product is selected
  useEffect(() => {
    setActivePhotoIndex(0);
    setIsAdded(false);
  }, [product.id]);

  // Keyboard navigation and ESC to close
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") {
        setActivePhotoIndex((prev) => (prev > 0 ? prev - 1 : product.photos.length - 1));
      }
      if (e.key === "ArrowRight") {
        setActivePhotoIndex((prev) => (prev < product.photos.length - 1 ? prev + 1 : 0));
      }
    },
    [isOpen, onClose, product.photos.length]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    if (isOpen) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "unset";
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  const currentPhoto = product.photos[activePhotoIndex] || product.photos[0];
  const discountPercent = calculateDiscount(product.sellingPrice, product.costPrice);

  const handleModalAddToCart = () => {
    if (onAddToCart) onAddToCart(product);
    setIsAdded(true);
    setTimeout(() => setIsAdded(false), 2000);
  };

  const handleWhatsAppClaim = () => {
    const message = `Hello Adonai Thrift Store, I would like to order:\n- Item: ${product.name}\n- SKU: ${product.sku}\n- Size: ${product.size}\n- Price: ${formatUGX(product.sellingPrice)}\nIs this piece still available for delivery?`;
    window.open(`https://wa.me/256758893398?text=${encodeURIComponent(message)}`, "_blank");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 md:p-6 bg-stone-900/60 backdrop-blur-sm animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl max-h-[92vh] overflow-y-auto bg-white rounded-2xl shadow-2xl border border-stone-200 grid grid-cols-1 md:grid-cols-2 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-3.5 right-3.5 z-20 p-2 rounded-full bg-stone-100 hover:bg-stone-200 text-stone-700 transition-colors focus:outline-none focus:ring-2 focus:ring-stone-400"
          aria-label="Close product detail modal"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {/* Left Column: Interactive Photo Gallery */}
        <div className="p-4 sm:p-6 bg-stone-50 flex flex-col justify-between border-b md:border-b-0 md:border-r border-stone-200">
          <div>
            {/* Primary Preview Stage */}
            <div className="relative aspect-[4/3.5] w-full bg-white rounded-xl overflow-hidden border border-stone-200 flex items-center justify-center group">
              {currentPhoto ? (
                <img
                  src={currentPhoto.url}
                  alt={currentPhoto.alt || product.name}
                  className="w-full h-full object-cover transition-all duration-300"
                />
              ) : (
                <div className="text-stone-400 text-sm font-medium">No Image Available</div>
              )}

              {/* Prev / Next Angle Buttons */}
              {product.photos.length > 1 && (
                <>
                  <button
                    onClick={() => setActivePhotoIndex((prev) => (prev > 0 ? prev - 1 : product.photos.length - 1))}
                    className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/90 hover:bg-white text-stone-800 shadow-md flex items-center justify-center transition-transform hover:scale-110 focus:outline-none"
                    aria-label="Previous image angle"
                  >
                    ‹
                  </button>
                  <button
                    onClick={() => setActivePhotoIndex((prev) => (prev < product.photos.length - 1 ? prev + 1 : 0))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full bg-white/90 hover:bg-white text-stone-800 shadow-md flex items-center justify-center transition-transform hover:scale-110 focus:outline-none"
                    aria-label="Next image angle"
                  >
                    ›
                  </button>
                </>
              )}

              {/* Angle Tag Indicator */}
              {currentPhoto && (
                <span className="absolute bottom-2.5 left-2.5 bg-stone-900/80 text-white text-[11px] font-semibold tracking-wide px-2.5 py-1 rounded-full backdrop-blur-sm">
                  {currentPhoto.label} View ({activePhotoIndex + 1}/{product.photos.length})
                </span>
              )}
            </div>

            {/* Thumbnail Navigation Row */}
            {product.photos.length > 1 && (
              <div className="grid grid-cols-4 gap-2.5 mt-3">
                {product.photos.map((photo, idx) => (
                  <button
                    key={photo.id || idx}
                    onClick={() => setActivePhotoIndex(idx)}
                    className={`relative aspect-square rounded-lg overflow-hidden border-2 transition-all ${
                      idx === activePhotoIndex
                        ? "border-[#C24E2B] ring-2 ring-[#C24E2B]/20 scale-102"
                        : "border-stone-200 hover:border-stone-400 opacity-75 hover:opacity-100"
                    }`}
                    aria-label={`View ${photo.label} angle`}
                  >
                    <img src={photo.url} alt={photo.alt} className="w-full h-full object-cover" />
                    <span className="absolute inset-x-0 bottom-0 bg-stone-900/70 text-white text-[9px] font-medium text-center py-0.5 truncate">
                      {photo.label}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <p className="mt-4 text-center text-xs text-stone-500 font-medium">
            📷 Authentic 1-of-1 photograph · Inspected &amp; cleaned in Kampala
          </p>
        </div>

        {/* Right Column: Specs, Pricing & Actions */}
        <div className="p-5 sm:p-7 flex flex-col justify-between">
          <div className="space-y-4">
            {/* Header info */}
            <div>
              <div className="flex items-center justify-between text-xs font-semibold text-[#C24E2B] tracking-wider uppercase">
                <span>{product.demographic} · {product.category}</span>
                <span className="text-stone-400 font-mono text-[11px]">{product.sku}</span>
              </div>
              <h2 id={titleId} className="text-xl sm:text-2xl font-bold font-serif text-stone-900 mt-1 leading-tight">
                {product.name}
              </h2>
              <div className="mt-2">
                <StarRating rating={product.rating} reviewCount={product.reviewCount} />
              </div>
            </div>

            {/* Price Box */}
            <div className="p-3.5 bg-stone-50 rounded-xl border border-stone-200 flex items-baseline gap-3 flex-wrap">
              <span className="text-2xl font-extrabold text-stone-900 font-serif">
                {formatUGX(product.sellingPrice)}
              </span>
              {product.costPrice > product.sellingPrice && (
                <>
                  <span className="text-sm font-medium text-stone-400 line-through">
                    {formatUGX(product.costPrice)}
                  </span>
                  <span className="bg-[#E11D48] text-white text-xs font-bold px-2 py-0.5 rounded-full">
                    {discountPercent}% OFF
                  </span>
                </>
              )}
            </div>

            {/* Specifications Matrix */}
            <div className="border border-stone-200 rounded-xl overflow-hidden divide-y divide-stone-100 text-xs sm:text-sm">
              <div className="flex justify-between px-3.5 py-2.5 bg-stone-50/50">
                <span className="text-stone-500 font-medium">Brand / Label</span>
                <span className="text-stone-900 font-semibold">{product.brand || "Vintage"}</span>
              </div>
              <div className="flex justify-between px-3.5 py-2.5">
                <span className="text-stone-500 font-medium">Size &amp; Fit</span>
                <span className="text-stone-900 font-semibold">{product.size}</span>
              </div>
              <div className="flex justify-between px-3.5 py-2.5 bg-stone-50/50">
                <span className="text-stone-500 font-medium">Condition Grade</span>
                <span className="text-emerald-700 font-semibold">{product.conditionGrade}</span>
              </div>
              <div className="flex justify-between px-3.5 py-2.5">
                <span className="text-stone-500 font-medium">Color / Wash</span>
                <span className="text-stone-900 font-semibold">{product.color}</span>
              </div>
              {product.material && (
                <div className="flex justify-between px-3.5 py-2.5 bg-stone-50/50">
                  <span className="text-stone-500 font-medium">Fabric Composition</span>
                  <span className="text-stone-900 font-semibold">{product.material}</span>
                </div>
              )}
            </div>

            {/* Description */}
            <p className="text-xs sm:text-sm text-stone-600 leading-relaxed">
              {product.description}
            </p>
          </div>

          {/* Action CTAs */}
          <div className="mt-6 space-y-2.5 pt-4 border-t border-stone-100">
            <button
              onClick={handleModalAddToCart}
              className={`w-full py-3.5 px-4 rounded-xl font-bold text-sm tracking-wide transition-all shadow-sm flex items-center justify-center gap-2.5 ${
                isAdded
                  ? "bg-emerald-600 text-white"
                  : "bg-[#C24E2B] hover:bg-[#A63F20] text-white active:scale-[0.99]"
              }`}
            >
              {isAdded ? (
                <>
                  <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  Added to Your Bag!
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
                  </svg>
                  Add to Cart ({formatUGX(product.sellingPrice)})
                </>
              )}
            </button>

            <button
              onClick={handleWhatsAppClaim}
              className="w-full py-3 px-4 rounded-xl font-bold text-xs tracking-wide bg-stone-100 hover:bg-stone-200 text-stone-800 transition-colors flex items-center justify-center gap-2"
            >
              <span>💬</span> Claim or Inquire via WhatsApp
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
   Main Product Card Component
   ============================================================================ */

export const AdonaiProductCard: React.FC<ProductCardProps> = ({
  product,
  onAddToCart,
  onOpenDetails,
  className = "",
  priorityImage = false,
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isAdded, setIsAdded] = useState(false);

  const discountPercent = calculateDiscount(product.sellingPrice, product.costPrice);
  const primaryPhoto = product.photos[0];

  const handleCardClick = () => {
    if (onOpenDetails) {
      onOpenDetails(product);
    } else {
      setIsModalOpen(true);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleCardClick();
    }
  };

  const handleAddToCartClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation(); // Prevent opening modal
    if (onAddToCart) {
      onAddToCart(product);
    }
    setIsAdded(true);
    setTimeout(() => setIsAdded(false), 1800);
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={`View details for ${product.name}, price ${formatUGX(product.sellingPrice)}`}
        onClick={handleCardClick}
        onKeyDown={handleKeyDown}
        className={`group relative flex flex-col justify-between bg-white rounded-xl border border-stone-200 p-3 sm:p-4 text-left transition-all duration-300 hover:shadow-md hover:border-stone-300 focus:outline-none focus:ring-2 focus:ring-[#C24E2B]/50 cursor-pointer ${className}`}
      >
        <div>
          {/* ================= Image Preview Container ================= */}
          <div className="relative aspect-[4/3.5] w-full rounded-lg bg-stone-50 overflow-hidden flex items-center justify-center border border-stone-100/80">
            {/* Calculated Discount Badge (Top-Left Overlay) */}
            {discountPercent > 0 && (
              <span
                className="absolute top-2.5 left-2.5 z-10 bg-[#E11D48] text-white text-[11px] font-bold tracking-tight px-2.5 py-1 rounded-full shadow-sm animate-in fade-in"
                aria-label={`${discountPercent} percent discount`}
              >
                {discountPercent}% OFF
              </span>
            )}

            {/* Product Image with Subtle Hover Zoom */}
            {primaryPhoto ? (
              <img
                src={primaryPhoto.url}
                alt={primaryPhoto.alt || product.name}
                loading={priorityImage ? "eager" : "lazy"}
                className="w-full h-full object-cover transition-transform duration-300 ease-out group-hover:scale-105"
              />
            ) : (
              <div className="flex flex-col items-center justify-center text-stone-400 gap-1">
                <svg className="w-8 h-8 text-stone-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span className="text-[11px] font-medium">Adonai Thrift</span>
              </div>
            )}
          </div>

          {/* ================= Product Info Section ================= */}
          <div className="mt-3.5 space-y-1.5">
            {/* Category / Brand metadata */}
            <div className="flex items-center justify-between text-[11px] font-medium text-stone-500">
              <span className="truncate">{product.brand || "Vintage"}</span>
              <span className="text-stone-400 font-mono text-[10px]">{product.sku}</span>
            </div>

            {/* 2-Line Truncated Title */}
            <h3 className="font-serif font-bold text-sm sm:text-base text-stone-900 leading-snug line-clamp-2 group-hover:text-[#C24E2B] transition-colors">
              {product.name}
            </h3>

            {/* Social Proof Rating */}
            <div className="pt-0.5">
              <StarRating rating={product.rating} reviewCount={product.reviewCount} />
            </div>

            {/* Pricing Block */}
            <div className="pt-1.5 flex items-baseline gap-2 flex-wrap">
              <span className="font-bold text-base sm:text-lg text-stone-900 font-serif">
                {formatUGX(product.sellingPrice)}
              </span>
              {product.costPrice > product.sellingPrice && (
                <span className="text-xs text-stone-400 line-through font-medium">
                  {formatUGX(product.costPrice)}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ================= CTA Button ================= */}
        <div className="mt-4 pt-2">
          <button
            type="button"
            onClick={handleAddToCartClick}
            aria-label={`Add ${product.name} to cart for ${formatUGX(product.sellingPrice)}`}
            className={`w-full py-2.5 px-3 rounded-lg font-semibold text-xs sm:text-sm tracking-wide transition-all duration-200 flex items-center justify-center gap-2 shadow-sm ${
              isAdded
                ? "bg-emerald-600 text-white"
                : "bg-stone-900 hover:bg-[#C24E2B] text-white active:scale-[0.98]"
            }`}
          >
            {isAdded ? (
              <>
                <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Added!
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
                </svg>
                Add to Cart
              </>
            )}
          </button>
        </div>
      </div>

      {/* Built-in Product Detail Modal */}
      <ProductDetailModal
        product={product}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onAddToCart={onAddToCart}
      />
    </>
  );
};

/* ============================================================================
   Demo Responsive Grid Showcase (2-col mobile, 4-col desktop)
   ============================================================================ */

export const SAMPLE_PRODUCTS: Product[] = [
  {
    id: "prod-1",
    sku: "ADN-DEN-1001",
    name: "Vintage Levi's Type III Trucker Denim Jacket",
    brand: "Levi Strauss & Co.",
    category: "Outerwear & Jackets",
    demographic: "Unisex",
    size: "Medium (40R)",
    color: "Faded Stonewash Indigo",
    conditionGrade: "Grade A — Excellent",
    sellingPrice: 45000,
    costPrice: 65000,
    rating: 4.9,
    reviewCount: 38,
    inStockCount: 1,
    description: "Authentic 1990s heavy stonewash denim jacket featuring classic copper rivets, dual chest flap pockets, and natural edge patina. Laundried and sanitized at our Kampala Road workshop.",
    material: "100% Ring-Spun Cotton Denim",
    photos: [
      { id: "p1", url: "https://images.unsplash.com/photo-1576995853123-5a10305d93c0?auto=format&fit=crop&w=800&q=80", alt: "Denim Jacket Front View", label: "Front" },
      { id: "p2", url: "https://images.unsplash.com/photo-1551028719-00167b16eac5?auto=format&fit=crop&w=800&q=80", alt: "Denim Jacket Back View", label: "Back" },
      { id: "p3", url: "https://images.unsplash.com/photo-1548883354-7622d03aca27?auto=format&fit=crop&w=800&q=80", alt: "Fabric texture closeup", label: "Fabric" },
      { id: "p4", url: "https://images.unsplash.com/photo-1582533561751-ef6f6ab93a2e?auto=format&fit=crop&w=800&q=80", alt: "Authenticity tag", label: "Tag" },
    ],
  },
  {
    id: "prod-2",
    sku: "ADN-MIL-1002",
    name: "Classic Khaki Field Overshirt with Utility Pockets",
    brand: "Carhartt WIP",
    category: "Tops & Shirts",
    demographic: "Men",
    size: "Large",
    color: "Olive / Army Khaki",
    conditionGrade: "Grade A — Excellent",
    sellingPrice: 38000,
    costPrice: 50000,
    rating: 4.8,
    reviewCount: 22,
    inStockCount: 1,
    description: "Durable military twill overshirt with reinforced elbow stitching and heavy-duty horn buttons. Versatile Kampala evening outerwear.",
    material: "100% Heavy Twill Cotton",
    photos: [
      { id: "p5", url: "https://images.unsplash.com/photo-1596755094514-f87e34085b2c?auto=format&fit=crop&w=800&q=80", alt: "Overshirt Front", label: "Front" },
      { id: "p6", url: "https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?auto=format&fit=crop&w=800&q=80", alt: "Overshirt Back", label: "Back" },
      { id: "p7", url: "https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?auto=format&fit=crop&w=800&q=80", alt: "Fabric texture", label: "Fabric" },
    ],
  },
  {
    id: "prod-3",
    sku: "ADN-DRS-1003",
    name: "Pleated Floral Midi Tea Dress with Belt",
    brand: "Laura Ashley Vintage",
    category: "Dresses & Skirts",
    demographic: "Women",
    size: "UK 10 / Small",
    color: "Terracotta & Cream",
    conditionGrade: "Grade B — Good",
    sellingPrice: 32000,
    costPrice: 42000,
    rating: 5.0,
    reviewCount: 14,
    inStockCount: 1,
    description: "Elegant breathable chiffon midi dress with delicate botanical print and waist-cinching matching belt. Dry-cleaned and ready to wear.",
    material: "Chiffon / Rayon Blend",
    photos: [
      { id: "p8", url: "https://images.unsplash.com/photo-1572804013309-59a88b7e92f1?auto=format&fit=crop&w=800&q=80", alt: "Dress Front", label: "Front" },
      { id: "p9", url: "https://images.unsplash.com/photo-1595777457583-95e059d581b8?auto=format&fit=crop&w=800&q=80", alt: "Dress Fabric", label: "Fabric" },
    ],
  },
  {
    id: "prod-4",
    sku: "ADN-KNIT-1004",
    name: "Cable-Knit Wool Crewneck Heritage Sweater",
    brand: "Aran Crafts",
    category: "Outerwear & Jackets",
    demographic: "Unisex",
    size: "Large",
    color: "Oatmeal Heather",
    conditionGrade: "Grade A — Excellent",
    sellingPrice: 55000,
    costPrice: 55000, // No discount example
    rating: 4.7,
    reviewCount: 19,
    inStockCount: 1,
    description: "Pure virgin wool cable sweater crafted with traditional honeycomb and diamond stitching patterns. Super warm and enduring.",
    material: "100% Pure Virgin Wool",
    photos: [
      { id: "p10", url: "https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?auto=format&fit=crop&w=800&q=80", alt: "Sweater Front", label: "Front" },
    ],
  },
];

export const AdonaiProductGrid: React.FC = () => {
  const [cartCount, setCartCount] = useState(0);

  const handleAddToCart = (product: Product) => {
    setCartCount((prev) => prev + 1);
  };

  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      {/* Section Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-8 pb-4 border-b border-stone-200 gap-4">
        <div>
          <span className="text-xs font-bold tracking-widest text-[#C24E2B] uppercase">
            Curated 1-of-1 Thrift · Kampala
          </span>
          <h2 className="text-2xl sm:text-3xl font-extrabold font-serif text-stone-900 mt-1">
            Featured Rail Drops
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-stone-500">
            Shopping Bag: <strong>{cartCount} items</strong>
          </span>
        </div>
      </div>

      {/* Responsive Grid: 2-column mobile, 3-col tablet, 4-column desktop */}
      <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5 sm:gap-5 lg:gap-6">
        {SAMPLE_PRODUCTS.map((product, idx) => (
          <AdonaiProductCard
            key={product.id}
            product={product}
            onAddToCart={handleAddToCart}
            priorityImage={idx < 2}
          />
        ))}
      </div>
    </section>
  );
};

export default AdonaiProductCard;
