import type { CSSProperties } from "react";
import type { ButtonSpec } from "@/lib/validation/leadbutton";

/**
 * ONE source of truth for how a ButtonSpec renders.
 * Used by the builder's phone preview AND the real public landing page, so
 * what the admin sees is exactly what the customer gets.
 */

const RADIUS: Record<ButtonSpec["shape"], string> = {
  pill: "9999px",
  rounded: "12px",
  square: "4px",
};

const SIZE: Record<ButtonSpec["size"], { padding: string; fontSize: string; minHeight: string }> = {
  sm: { padding: "8px 16px", fontSize: "13px", minHeight: "36px" },
  md: { padding: "11px 22px", fontSize: "15px", minHeight: "44px" },
  lg: { padding: "14px 28px", fontSize: "17px", minHeight: "52px" },
};

export function leadButtonStyle(spec: ButtonSpec): CSSProperties {
  const size = SIZE[spec.size];
  const outline = spec.style === "outline";
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    width: "100%",
    border: outline
      ? `2px solid ${spec.border ?? spec.bg}`
      : spec.border
        ? `2px solid ${spec.border}`
        : "2px solid transparent",
    background: outline ? "transparent" : spec.bg,
    color: outline ? (spec.border ?? spec.bg) : spec.fg,
    borderRadius: RADIUS[spec.shape],
    padding: size.padding,
    fontSize: size.fontSize,
    minHeight: size.minHeight,
    fontWeight: 600,
    lineHeight: 1.2,
    cursor: "pointer",
    transition: "transform 0.1s ease, opacity 0.15s ease",
    userSelect: "none",
    textAlign: "center",
  };
}
