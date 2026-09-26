import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /**
         * Warm terracotta & olive.
         *
         * Token names are unchanged from the previous palette on purpose, so the
         * ~250 existing `bg-ink-900` / `text-clay-600` usages pick the new
         * colours up without being touched. Only the values move.
         */
        ink: {
          // Warm espresso rather than neutral black — reads softer against sand.
          900: "#2E221B",
          800: "#3E2F26",
          700: "#55443A",
          600: "#857167",
        },
        /** Terracotta — the primary accent. Full ramp; `clay-50` was previously
         *  referenced in 14 places but never defined, so it rendered nothing. */
        clay: {
          50: "#FDF2EC",
          100: "#F9E1D4",
          200: "#F1C3AB",
          300: "#E49C7C",
          400: "#D4714C",
          500: "#BC5531",
          600: "#9A4225",
          700: "#7A341D",
        },
        /** Ochre — keeps its old name; the value warms to sit beside terracotta. */
        brass: { 400: "#E8B65C", 500: "#D69A2E", 600: "#AF7A1D" },
        /** New: secondary accent for live/success states and category chips. */
        olive: {
          50: "#F3F5EC",
          100: "#E4E9D5",
          200: "#CBD4AE",
          300: "#ADBA85",
          400: "#8E9C5F",
          500: "#71803F",
          600: "#5A6731",
          700: "#454F26",
        },
        /** Warm paper tones, replacing bare #fff / #faf7f2 literals. */
        sand: { 50: "#FDF8F3", 100: "#FAF1E8", 200: "#F3E5D6" },
      },
      fontFamily: {
        // Soft boutique serif for H1/H2. Loaded from Google Fonts at runtime;
        // falls back cleanly when the CDN is unreachable.
        display: ['"Fraunces"', "Lora", '"Hoefler Text"', "Georgia", '"Times New Roman"', "serif"],
        // Rounded geometric grotesque for everything else.
        sans: ["Outfit", '"Plus Jakarta Sans"', "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", "Helvetica", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      letterSpacing: { editorial: "-0.02em", card: "0.03em" },
      borderRadius: { card: "1rem", pill: "999px" },
      boxShadow: {
        // Warm-tinted lift instead of the old neutral grey shadow.
        card: "0 1px 0 rgba(122,52,29,0.05), 0 18px 34px -26px rgba(122,52,29,0.40)",
        lift: "0 2px 0 rgba(122,52,29,0.06), 0 24px 44px -24px rgba(122,52,29,0.45)",
      },
      keyframes: {
        slideIn: { from: { transform: "translateX(100%)" }, to: { transform: "translateX(0)" } },
        pop: { "0%": { transform: "scale(.94)", opacity: "0" }, "100%": { transform: "scale(1)", opacity: "1" } },
      },
      animation: { slideIn: "slideIn .22s ease-out", pop: "pop .14s ease-out" },
    },
  },
  plugins: [],
} satisfies Config;
