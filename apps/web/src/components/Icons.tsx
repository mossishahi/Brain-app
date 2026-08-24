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

/** Conventional cog outline; deliberately distinct from the sun's rays. */
export function GearIcon({ size = 18 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/**
 * A brain outline: two mirrored hemispheres with a center seam. Opens the
 * recorded thinking behind a version card — grey like every ghost control,
 * so it reads as a peek at working material rather than as an artifact.
 */
/** A pencil over a writing line: the tracked-changes document control. */
export function EditIcon({ size = 16 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5Z" />
      <path d="M13.5 6.5l3 3M4 21h16" />
    </svg>
  );
}

export function BrainIcon({ size = 16 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M11 4.2a2.6 2.6 0 0 0-4.5 1.1 2.8 2.8 0 0 0-2.2 3.4 2.9 2.9 0 0 0-.6 4.6 2.9 2.9 0 0 0 1.6 4 2.7 2.7 0 0 0 4.2 2A2.4 2.4 0 0 0 11 18V4.2Z" />
      <path d="M13 4.2a2.6 2.6 0 0 1 4.5 1.1 2.8 2.8 0 0 1 2.2 3.4 2.9 2.9 0 0 1 .6 4.6 2.9 2.9 0 0 1-1.6 4 2.7 2.7 0 0 1-4.2 2A2.4 2.4 0 0 1 13 18V4.2Z" />
    </svg>
  );
}

/**
 * A filled square: the universal "stop". Deliberately NOT the ✕ this control
 * used to wear — an ✕ reads as "close this", so a run that could be stopped
 * looked like it could only be dismissed, and the control went unseen.
 */
export function StopIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

/**
 * A control waiting on the server. Shown IN PLACE of the icon, so the button
 * says "I heard you" on the click rather than at the next snapshot — the
 * round trip plus a scheduler call is seconds, and a control that does not
 * move for seconds reads as a control that did not work.
 */
export function ButtonSpinner({ size = 14 }: IconProps) {
  return (
    <span
      className="btn-spinner"
      style={{ width: size, height: size }}
      role="status"
      aria-label="working"
    />
  );
}

/** Two bars: the run stops where it is and keeps its place. */
export function PauseIcon({ size = 18 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <line x1="9" y1="5" x2="9" y2="19" />
      <line x1="15" y1="5" x2="15" y2="19" />
    </svg>
  );
}

export function TrashIcon({ size = 18 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export function ChevronIcon({ size = 14 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <polyline points="9 18 15 12 9 6" />
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

export function CopyIcon({ size = 14 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function DownloadIcon({ size = 14 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

export function ForwardIcon({ size = 18 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
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

/** Model connection: a four-point spark. */
export function SparkIcon({ size = 16 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M12 8.5 13.6 10.4 15.5 12 13.6 13.6 12 15.5 10.4 13.6 8.5 12 10.4 10.4Z" />
    </svg>
  );
}

/** Code workspace: a terminal prompt. */
export function TerminalIcon({ size = 16 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7 9.5 3 2.5-3 2.5" />
      <path d="M12.5 15H17" />
    </svg>
  );
}

/** Internet access: a globe. */
export function GlobeIcon({ size = 16 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a13.5 13.5 0 0 1 0 18a13.5 13.5 0 0 1 0-18Z" />
    </svg>
  );
}

/** Agent capabilities: a power plug — the tools agents plug into. */
export function PlugIcon({ size = 16 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M9 3v5M15 3v5" />
      <path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-5.5 5.5a5.5 5.5 0 0 1-5.5-5.5Z" />
      <path d="M12 17v4" />
    </svg>
  );
}

/** SLURM scheduler: stacked queue layers. */
export function QueueIcon({ size = 16 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="m12 3 9 4.5-9 4.5-9-4.5Z" />
      <path d="m3 12.5 9 4.5 9-4.5" />
      <path d="m3 17 9 4.5 9-4.5" />
    </svg>
  );
}

/** Resume an interrupted job: circular arrow into a play head. */
export function ResumeIcon({ size = 16 }: IconProps) {
  return (
    <svg {...frame(size)}>
      <path d="M21 12a9 9 0 1 1-3.1-6.8" />
      <path d="M21 4v5h-5" />
      <path d="m10.5 9.5 4 2.5-4 2.5Z" />
    </svg>
  );
}
