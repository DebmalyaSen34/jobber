import { Suspense } from "react";
import { KitWorkspace } from "@/components/kit-workspace";
import { RouteLoading } from "@/components/loading-state";

export default function KitPage({ params }: PageProps<"/kits/[kitId]">) {
  return (
    <Suspense fallback={<RouteLoading label="Loading kit…" />}>
      {params.then(({ kitId }) => <KitWorkspace kitId={kitId} />)}
    </Suspense>
  );
}
