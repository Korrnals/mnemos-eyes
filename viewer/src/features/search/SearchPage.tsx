import { SearchBar } from "@/components/SearchBar/SearchBar";
import { Card, CardContent } from "@/components/ui/card";

/**
 * `/` — dashboard hero + unified search (architecture.md §3).
 * TODO(T5): "the well" hero — IrisLogo 160px + breathing + staggered results.
 */
export function SearchPage() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-6 p-12">
        <h1 className="text-xl font-semibold">a gaze into oneself</h1>
        <SearchBar className="w-full max-w-xl" />
        <p className="text-sm text-foreground-secondary">
          Search is implemented in task T5 (features/search against the gateway).
        </p>
      </CardContent>
    </Card>
  );
}
