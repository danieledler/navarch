import { useMemo } from "react";
import { encode } from "uqr";

/** Quiet zone in modules: the spec's 4, so phone cameras find the code on any background. */
const QUIET = 4;

/** A QR code as inline SVG: dark modules on white, also in dark mode, which is what cameras read best. */
export function QrCode({ value, size = 136, label }: { value: string; size?: number; label: string }) {
  const { n, d } = useMemo(() => {
    const { size: n, data } = encode(value, { ecc: "M", border: 0 });
    // One path, a run of dark modules per segment, so a code is a few hundred bytes of DOM.
    let d = "";
    data.forEach((row, y) => {
      for (let x = 0; x < n; x++) {
        if (!row[x]) continue;
        let w = 1;
        while (x + w < n && row[x + w]) w++;
        d += `M${x + QUIET} ${y + QUIET}h${w}v1h-${w}z`;
        x += w - 1;
      }
    });
    return { n, d };
  }, [value]);
  const full = n + 2 * QUIET;
  return (
    <svg
      className="qr" role="img" aria-label={label} width={size} height={size}
      viewBox={`0 0 ${full} ${full}`} shapeRendering="crispEdges"
    >
      <rect width={full} height={full} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
