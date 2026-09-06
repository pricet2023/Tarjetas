import type { Config } from "tailwindcss";

/**
 * Theme for the "brushed metal" look: a graphite base, steel surfaces and a
 * small set of neon accents that do all the highlighting. The heavier
 * gradients live as component classes in `src/index.css` — anything that needs
 * more than one background layer is unreadable as a utility string.
 */
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Space Grotesk"',
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          '"Segoe UI"',
          "sans-serif",
        ],
        mono: [
          '"JetBrains Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      colors: {
        ink: {
          950: "#04060a",
          900: "#070a10",
          800: "#0b0f17",
          700: "#101621",
          600: "#161e2c",
        },
        steel: {
          50: "#f5f8fc",
          100: "#e7eef7",
          200: "#c9d6e6",
          300: "#a4b5cb",
          400: "#7a8da7",
          500: "#58687d",
          600: "#3f4b5d",
          700: "#2b3444",
          800: "#1b2231",
          900: "#121824",
        },
        neon: {
          cyan: "#22d3ee",
          ice: "#7dd3fc",
          mint: "#34d399",
          violet: "#a78bfa",
          magenta: "#f472b6",
          amber: "#fbbf24",
        },
      },
      boxShadow: {
        // A machined plate: bright top rim, dark bottom rim, deep drop.
        plate:
          "inset 0 1px 0 0 rgba(255,255,255,0.10), inset 0 -1px 0 0 rgba(0,0,0,0.6), 0 18px 40px -22px rgba(0,0,0,0.95)",
        rise:
          "inset 0 1px 0 0 rgba(255,255,255,0.16), inset 0 -1px 0 0 rgba(0,0,0,0.6), 0 40px 70px -24px rgba(0,0,0,1)",
        inset: "inset 0 2px 6px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.06)",
        cyan: "0 0 0 1px rgba(34,211,238,0.35), 0 0 30px -6px rgba(34,211,238,0.55)",
        violet: "0 0 0 1px rgba(167,139,250,0.35), 0 0 30px -6px rgba(167,139,250,0.55)",
        mint: "0 0 0 1px rgba(52,211,153,0.4), 0 0 34px -6px rgba(52,211,153,0.6)",
        rose: "0 0 0 1px rgba(251,113,133,0.4), 0 0 34px -6px rgba(251,113,133,0.6)",
      },
      transitionTimingFunction: {
        metal: "cubic-bezier(0.22, 1, 0.36, 1)",
        snap: "cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
      keyframes: {
        popIn: {
          "0%": { transform: "scale(0.94)", opacity: "0" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        // No filter or opacity below 1 here: both would flatten the card's
        // preserve-3d wrapper while it played.
        cardIn: {
          "0%": { transform: "translateY(24px) scale(0.94)" },
          "100%": { transform: "translateY(0) scale(1)" },
        },
        riseIn: {
          "0%": { transform: "translateY(14px)", opacity: "0", filter: "blur(6px)" },
          "100%": { transform: "translateY(0)", opacity: "1", filter: "blur(0)" },
        },
        charIn: {
          "0%": { transform: "translateY(8px)", opacity: "0", filter: "blur(4px)" },
          "100%": { transform: "translateY(0)", opacity: "1", filter: "blur(0)" },
        },
        sheen: {
          "0%": { transform: "translateX(-130%) skewX(-18deg)", opacity: "0" },
          "12%": { opacity: "1" },
          "100%": { transform: "translateX(240%) skewX(-18deg)", opacity: "0" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        scan: {
          "0%": { transform: "translateY(-140%)", opacity: "0" },
          "20%": { opacity: "1" },
          "80%": { opacity: "1" },
          "100%": { transform: "translateY(340%)", opacity: "0" },
        },
        gridPan: {
          "0%": { backgroundPosition: "0 0, 0 0" },
          "100%": { backgroundPosition: "44px 44px, 44px 44px" },
        },
        floatY: {
          "0%, 100%": { transform: "translate3d(0,0,0) scale(1)" },
          "50%": { transform: "translate3d(0,-26px,0) scale(1.06)" },
        },
        spinSlow: {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        ringOut: {
          "0%": { transform: "scale(0.55)", opacity: "0.85" },
          "100%": { transform: "scale(2.1)", opacity: "0" },
        },
        stampIn: {
          "0%": { transform: "scale(1.7)", opacity: "0" },
          "55%": { transform: "scale(0.94)", opacity: "1" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        flipPulse: {
          "0%, 100%": { transform: "scale(1)" },
          "45%": { transform: "scale(1.05)" },
        },
        edgeFlash: {
          "0%": { opacity: "0" },
          "25%": { opacity: "1" },
          "100%": { opacity: "0" },
        },
        pulseGlow: {
          "0%, 100%": { opacity: "0.45" },
          "50%": { opacity: "1" },
        },
        countPop: {
          "0%": { transform: "scale(1.4)", opacity: "0.3", filter: "blur(3px)" },
          "100%": { transform: "scale(1)", opacity: "1", filter: "blur(0)" },
        },
        ticker: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.15" },
        },
      },
      animation: {
        popIn: "popIn 200ms cubic-bezier(0.34, 1.56, 0.64, 1) both",
        cardIn: "cardIn 320ms cubic-bezier(0.22, 1, 0.36, 1) both",
        riseIn: "riseIn 420ms cubic-bezier(0.22, 1, 0.36, 1) both",
        charIn: "charIn 320ms cubic-bezier(0.22, 1, 0.36, 1) both",
        sheen: "sheen 1.1s cubic-bezier(0.22, 1, 0.36, 1)",
        sheenLoop: "sheen 3.6s cubic-bezier(0.22, 1, 0.36, 1) infinite",
        shimmer: "shimmer 1.6s linear infinite",
        scan: "scan 1.15s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        gridPan: "gridPan 12s linear infinite",
        floatY: "floatY 11s ease-in-out infinite",
        spinSlow: "spinSlow 14s linear infinite",
        spinFast: "spinSlow 1.4s linear infinite",
        ringOut: "ringOut 700ms cubic-bezier(0.22, 1, 0.36, 1) both",
        stampIn: "stampIn 340ms cubic-bezier(0.34, 1.56, 0.64, 1) both",
        flipPulse: "flipPulse 420ms cubic-bezier(0.22, 1, 0.36, 1)",
        edgeFlash: "edgeFlash 520ms ease-out both",
        pulseGlow: "pulseGlow 2.4s ease-in-out infinite",
        countPop: "countPop 260ms cubic-bezier(0.34, 1.56, 0.64, 1) both",
        ticker: "ticker 1.8s ease-in-out infinite",
      },
    },
  },
};

export default config;
