import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CONNECTION_COLORS } from "@/lib/schemas";
import { cn } from "@/lib/utils";

type Hsv = { h: number; s: number; v: number };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function hexToHsv(hex: string): Hsv {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return { h: 0, s: 0, v: 100 };
  const x = m[1];
  const r = Number.parseInt(x.slice(0, 2), 16) / 255;
  const g = Number.parseInt(x.slice(2, 4), 16) / 255;
  const b = Number.parseInt(x.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s: max === 0 ? 0 : (d / max) * 100, v: max * 100 };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const sN = s / 100;
  const vN = v / 100;
  const c = vN * sN;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = vN - c;
  const to = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

const PRESET_VALUES: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (const c of CONNECTION_COLORS) {
    if (c.value !== null) out.add(c.value);
  }
  return out;
})();

type Props = {
  value: string | null;
  onChange: (v: string | null) => void;
};

export function ColorPicker({ value, onChange }: Props) {
  const isCustom = value !== null && !PRESET_VALUES.has(value);

  const [hsv, setHsv] = useState<Hsv>(() =>
    isCustom ? hexToHsv(value as string) : { h: 0, s: 80, v: 90 },
  );
  const [hexInput, setHexInput] = useState(() => (isCustom ? (value as string) : ""));
  const lastCommittedRef = useRef<string | null>(value);

  useEffect(() => {
    if (value !== null && value !== lastCommittedRef.current) {
      setHsv(hexToHsv(value));
      setHexInput(value);
    }
    lastCommittedRef.current = value;
  }, [value]);

  const commitHex = (hex: string) => {
    lastCommittedRef.current = hex;
    setHexInput(hex);
    onChange(hex);
  };

  const commitHsv = (next: Hsv) => {
    setHsv(next);
    commitHex(hsvToHex(next));
  };

  const slRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  const onSLPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = slRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const apply = (cx: number, cy: number) => {
      const sx = clamp((cx - rect.left) / rect.width, 0, 1);
      const sy = clamp((cy - rect.top) / rect.height, 0, 1);
      commitHsv({ h: hsv.h, s: sx * 100, v: (1 - sy) * 100 });
    };
    apply(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => apply(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onHuePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = hueRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const apply = (cx: number) => {
      const sx = clamp((cx - rect.left) / rect.width, 0, 1);
      commitHsv({ ...hsv, h: sx * 360 });
    };
    apply(e.clientX);
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onHexChange = (raw: string) => {
    setHexInput(raw);
    const m = /^#?([\da-f]{6})$/i.exec(raw.trim());
    if (m) {
      const hex = `#${m[1].toLowerCase()}`;
      setHsv(hexToHsv(hex));
      commitHex(hex);
    }
  };

  return (
    <div className="flex flex-wrap gap-1.5">
      {CONNECTION_COLORS.map((c) => {
        const selected = !isCustom && (value ?? null) === c.value;
        const isNone = c.value === null;
        return (
          <button
            key={c.name}
            type="button"
            onClick={() => onChange(c.value)}
            aria-label={c.name}
            title={c.name}
            className={cn(
              "size-6 rounded-full border transition-all",
              selected
                ? "border-foreground ring-2 ring-foreground/30"
                : "border-border hover:scale-110",
              isNone && "bg-transparent",
            )}
            style={isNone ? undefined : { backgroundColor: c.swatch }}
          >
            {isNone && <span className="text-[10px] text-muted-foreground">∅</span>}
          </button>
        );
      })}

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Custom color"
            title="Custom color"
            className={cn(
              "size-6 rounded-full border transition-all",
              isCustom
                ? "border-foreground ring-2 ring-foreground/30"
                : "border-border hover:scale-110",
            )}
            style={
              isCustom
                ? { backgroundColor: value as string }
                : {
                    background:
                      "conic-gradient(from 0deg, #ef4444, #f59e0b, #22c55e, #14b8a6, #3b82f6, #8b5cf6, #ec4899, #ef4444)",
                  }
            }
          />
        </PopoverTrigger>
        <PopoverContent className="w-60 space-y-3">
          <div
            ref={slRef}
            onPointerDown={onSLPointerDown}
            className="relative h-36 w-full cursor-crosshair touch-none rounded-md select-none"
            style={{ backgroundColor: `hsl(${hsv.h}, 100%, 50%)` }}
          >
            <div
              className="pointer-events-none absolute inset-0 rounded-md"
              style={{
                background: "linear-gradient(to right, #fff, rgba(255,255,255,0))",
              }}
            />
            <div
              className="pointer-events-none absolute inset-0 rounded-md"
              style={{
                background: "linear-gradient(to top, #000, rgba(0,0,0,0))",
              }}
            />
            <div
              className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              style={{
                left: `${hsv.s}%`,
                top: `${100 - hsv.v}%`,
                backgroundColor: hsvToHex(hsv),
              }}
            />
          </div>

          <div
            ref={hueRef}
            onPointerDown={onHuePointerDown}
            className="relative h-3 w-full cursor-pointer touch-none rounded-full select-none"
            style={{
              background:
                "linear-gradient(to right, hsl(0,100%,50%), hsl(60,100%,50%), hsl(120,100%,50%), hsl(180,100%,50%), hsl(240,100%,50%), hsl(300,100%,50%), hsl(360,100%,50%))",
            }}
          >
            <div
              className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              style={{
                left: `${(hsv.h / 360) * 100}%`,
                backgroundColor: `hsl(${hsv.h}, 100%, 50%)`,
              }}
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Hex</span>
            <Input
              value={hexInput}
              onChange={(e) => onHexChange(e.target.value)}
              placeholder="#rrggbb"
              className="h-7 font-mono text-xs"
              maxLength={7}
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
