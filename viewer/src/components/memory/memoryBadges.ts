import type { TranslationKey } from "@/i18n";
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
 * i18n key for a memory status caption (pass 1: localized status labels).
 * Unknown statuses degrade to the raw enum word — the wire value stays
 * honest on screen.
 */
export function statusLabelKey(
  status: MemoryStatus | string | null | undefined,
): TranslationKey {
  switch (status) {
    case "raw":
      return "memstatus.raw";
    case "processing":
      return "memstatus.processing";
    case "processed":
      return "memstatus.processed";
    case "published":
      return "memstatus.published";
    case "archived":
      return "memstatus.archived";
    default:
      return "memstatus.raw";
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
