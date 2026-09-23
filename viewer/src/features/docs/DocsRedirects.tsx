import { Link, Navigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { useT } from "@/i18n";
import { DEFAULT_PROJECT, hubUrl } from "./projects";

/**
 * Small shared docs route components (W1c): the legacy category redirect and
 * the not-found state every docs page falls back to (design spec §8/§10).
 * Components only — the react-refresh lint rule stays meaningful.
 */

/**
 * The redirect-map miss (design spec §8): «Такой страницы нет» with the CTA
 * «Открыть документацию» into the section root. No second search field, no
 * banners — restoration goes through the CTA and the sidebar.
 */
export function DocsNotFound() {
  const t = useT();
  return (
    <EmptyState
      variant="not-found"
      title={t("docs.notFound.title")}
      message={t("docs.notFound.message")}
      action={
        <Button variant="outline" asChild>
          <Link to={hubUrl(DEFAULT_PROJECT)}>{t("docs.notFound.cta")}</Link>
        </Button>
      }
    />
  );
}

/**
 * Legacy `/docs/c/<category>` → the project-scoped URL (design spec §8):
 * synchronous, replace — invisible to the reader, Back skips the old URL.
 */
export function DocsCategoryLegacyRedirect() {
  const { category = "" } = useParams();
  return <Navigate to={`/docs/${DEFAULT_PROJECT}/c/${category}`} replace />;
}
