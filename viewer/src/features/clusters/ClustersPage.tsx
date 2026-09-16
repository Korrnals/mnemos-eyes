/**
 * L2 slot (ADR 0003 / D12): the cluster graph is deferred and its nav entry is
 * hidden in L1, so this page is intentionally NOT routed.
 * TODO(L2): graph view + library decision (React Flow vs d3-force).
 */
export function ClustersPage() {
  return (
    <section aria-labelledby="clusters-title" className="space-y-4">
      <h1 id="clusters-title" className="text-xl font-semibold">
        Clusters
      </h1>
      <p className="text-sm text-foreground-secondary">
        Cluster graph is deferred to L2 (D12).
      </p>
    </section>
  );
}
