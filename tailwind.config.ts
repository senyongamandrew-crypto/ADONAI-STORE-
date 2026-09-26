import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 900: "#1A1A1A", 800: "#262626", 700: "#333333", 600: "#5C5C5C" },
        brass: { 400: "#e0b25c", 500: "#c9922f", 600: "#a9761d" },
        clay: { 500: "#b4552d", 600: "#96441f" },
      },
      fontFamily: {
        // Editorial serif for H1/H2 — loaded from Google Fonts, falls back cleanly offline.
        display: ['"Playfair Display"', "Lora", '"Hoefler Text"', "Georgia", '"Times New Roman"', "serif"],
        // Legible grotesque for everything else.
        sans: ["Inter", '"Plus Jakarta Sans"', "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", "Helvetica", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      letterSpacing: { editorial: "-0.02em", card: "0.03em" },
      keyframes: {
        slideIn: { from: { transform: "translateX(100%)" }, to: { transform: "translateX(0)" } },
        pop: { "0%": { transform: "scale(.94)", opacity: "0" }, "100%": { transform: "scale(1)", opacity: "1" } },
      },
      animation: { slideIn: "slideIn .22s ease-out", pop: "pop .14s ease-out" },
    },
  },
  plugins: [],
} satisfies Config;
