/** Hand-rolled inline SVG glyphs. All stroke `currentColor`, decorative-free. */

interface IconProps {
  readonly size?: number;
}

function frame(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

function rays(inner: number, outer: number): string {
  let d = "";
  for (let i = 0; i < 8; i += 1) {
    const a = (i * Math.PI) / 4;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    d += `M${(12 + inner * cos).toFixed(2)} ${(12 + inner * sin).toFixed(2)}L${(12 + outer * cos).toFixed(2)} ${(12 + outer * sin).toFixed(2)}`;
  }
  return d;
}

export function SunIcon({ size = 18 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <circle cx="12" cy="12" r="3.6" />
      <path d={rays(6.6, 9.4)} />
    </svg>
  );
}

export function MoonIcon({ size = 18 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M20.4 13.2A8.4 8.4 0 1 1 10.8 3.6a6.8 6.8 0 0 0 9.6 9.6Z" />
    </svg>
  );
}

export function GearIcon({ size = 18 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <circle cx="12" cy="12" r="3.2" />
      <path d={rays(6.4, 9.6)} strokeWidth={2.4} />
    </svg>
  );
}

export function XIcon({ size = 16 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function BackIcon({ size = 18 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M19 12H5" />
      <path d="m11 18-6-6 6-6" />
    </svg>
  );
}

export function SendIcon({ size = 16 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}
