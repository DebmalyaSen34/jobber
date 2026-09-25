import { Suspense } from "react";
import { JobProgress } from "@/components/job-progress";

export default function JobPage({ params }: PageProps<"/jobs/[jobId]">) {
  return (
    <Suspense fallback={<div className="dashboard-state">Loading generation…</div>}>
      {params.then(({ jobId }) => <JobProgress jobId={jobId} />)}
    </Suspense>
  );
}
