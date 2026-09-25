import { Suspense } from "react";
import { JobProgress } from "@/components/job-progress";
import { RouteLoading } from "@/components/loading-state";

export default function JobPage({ params }: PageProps<"/jobs/[jobId]">) {
  return (
    <Suspense fallback={<RouteLoading label="Loading generation…" />}>
      {params.then(({ jobId }) => <JobProgress jobId={jobId} />)}
    </Suspense>
  );
}
