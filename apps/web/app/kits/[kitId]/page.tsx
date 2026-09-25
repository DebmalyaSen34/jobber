import { Suspense } from "react";
import { KitWorkspace } from "@/components/kit-workspace";

export default function KitPage({ params }: PageProps<"/kits/[kitId]">) {
  return (
    <Suspense fallback={<div className="dashboard-state">Loading kit…</div>}>
      {params.then(({ kitId }) => <KitWorkspace kitId={kitId} />)}
    </Suspense>
  );
}
