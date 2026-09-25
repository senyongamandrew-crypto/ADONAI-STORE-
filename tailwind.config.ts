import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 900: "#12100e", 800: "#1c1917", 700: "#292524", 600: "#44403c" },
        brass: { 400: "#e0b25c", 500: "#c9922f", 600: "#a9761d" },
        clay: { 500: "#b4552d", 600: "#96441f" },
      },
      fontFamily: {
        display: ["ui-serif", "Georgia", "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
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
