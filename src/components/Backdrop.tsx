/**
 * The ambient chassis behind every screen: a blueprint grid that drifts, two
 * slow accent orbs and a vignette. Purely decorative and pointer-transparent,
 * so it sits under the app at a negative z-index and never intercepts a drag.
 */
export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* Base wash. */}
      <div className="absolute inset-0 bg-ink-950" />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 80% at 10% -10%, rgba(34,211,238,0.16), transparent 60%)," +
            "radial-gradient(100% 70% at 92% 8%, rgba(167,139,250,0.14), transparent 62%)," +
            "radial-gradient(120% 90% at 50% 110%, rgba(14,165,233,0.12), transparent 65%)",
        }}
      />

      {/* Drifting grid, faded out towards the edges so it reads as a surface
          rather than wallpaper. */}
      <div
        className="bg-grid absolute inset-0 animate-gridPan opacity-70"
        style={{
          maskImage: "radial-gradient(115% 85% at 50% 30%, #000 35%, transparent 78%)",
          WebkitMaskImage: "radial-gradient(115% 85% at 50% 30%, #000 35%, transparent 78%)",
        }}
      />

      {/* Accent orbs. */}
      <div className="absolute -left-24 top-10 h-72 w-72 animate-floatY rounded-full bg-neon-cyan/20 blur-[90px]" />
      <div
        className="absolute -right-20 top-1/3 h-80 w-80 animate-floatY rounded-full bg-neon-violet/20 blur-[100px]"
        style={{ animationDelay: "-4s" }}
      />
      <div
        className="absolute bottom-0 left-1/3 h-64 w-64 animate-floatY rounded-full bg-neon-ice/10 blur-[80px]"
        style={{ animationDelay: "-8s" }}
      />

      {/* Horizon hairline + vignette. */}
      <div className="absolute inset-x-0 top-[62%] h-px bg-gradient-to-r from-transparent via-neon-ice/20 to-transparent" />
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(100% 100% at 50% 40%, transparent 45%, rgba(2,4,8,0.85) 100%)",
        }}
      />
    </div>
  );
}
