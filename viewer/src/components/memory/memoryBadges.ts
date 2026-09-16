import type { MemoryStatus } from "@/gateway/types";

/**
 * Badge variant mappings shared by memory surfaces (list card, scroll) and
 * tag chips. Token-bound Badge variants only (no literal colours).
 */
export function statusBadgeVariant(
  status: MemoryStatus | string | null | undefined,
): "default" | "iris" | "outline" | "success" | "error" {
  switch (status) {
    case "published":
      return "success";
    case "processing":
      return "iris";
    case "processed":
      return "outline";
    case "archived":
      return "outline";
    case "raw":
    default:
      return "default";
  }
}

/**
 * Tag prefix → colour mapping (component-inventory §6). Exported from this
 * non-component module so fast-refresh stays happy.
 */
export function tagVariant(tag: string): "default" | "iris" | "confidence" | "error" {
  if (tag === "confidence:high") return "confidence";
  if (tag === "status:error") return "error";
  if (tag.startsWith("type:") || tag.startsWith("mnemos:")) return "iris";
  return "default";
}
