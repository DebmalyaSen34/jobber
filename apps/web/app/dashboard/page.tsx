import { Brand } from "@/components/brand";
import { DashboardAccount } from "@/components/dashboard-account";

export default function DashboardPage() {
  return (
    <div className="dashboard-shell">
      <header className="site-header"><Brand /><span className="build-label">Private workspace</span></header>
      <main className="dashboard-main">
        <DashboardAccount />
        <section className="empty-workspace" aria-labelledby="workspace-heading">
          <p className="eyebrow">Your preparation kits</p>
          <h1 id="workspace-heading">A clear starting point.</h1>
          <p>Kit creation and generation progress arrive in the next foundation task. Your account and private workspace are ready.</p>
        </section>
      </main>
    </div>
  );
}
