/**
 * `/sessions` — A2A session list (architecture.md §3).
 * TODO(T5): wire `useSessions`.
 */
export function SessionsPage() {
  return (
    <section aria-labelledby="sessions-title" className="space-y-4">
      <h1 id="sessions-title" className="text-xl font-semibold">
        A2A sessions
      </h1>
      <p className="text-sm text-foreground-secondary">
        Session list is implemented in task T5 (features/sessions).
      </p>
    </section>
  );
}
