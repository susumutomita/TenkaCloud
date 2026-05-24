import "@cloudscape-design/global-styles/index.css";
import { Navigate, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { ShellLayout } from "./components/AppLayout";
import type { AppConfig } from "./config";
import { AuditLogPage } from "./pages/AuditLog";
import { CallbackPage } from "./pages/Callback";
import { CompetitorAccountsPage } from "./pages/CompetitorAccounts";
import { DeploymentDetailPage } from "./pages/DeploymentDetail";
import { DeploymentsPage } from "./pages/Deployments";
import { EventCreatePage } from "./pages/EventCreate";
import { EventDetailPage } from "./pages/EventDetail";
import { EventListPage } from "./pages/EventList";
import { HomePage } from "./pages/Home";
import { LoginPage } from "./pages/Login";
import { ProblemDetailPage } from "./pages/ProblemDetail";
import { ProblemsPage } from "./pages/Problems";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  if (!auth.ready) return null;
  if (!auth.tokens) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function guarded(element: React.ReactNode) {
  return (
    <RequireAuth>
      <ShellLayout>{element}</ShellLayout>
    </RequireAuth>
  );
}

export function App({ config }: { config: AppConfig }) {
  return (
    <AuthProvider config={config}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/callback" element={<CallbackPage config={config} />} />
        <Route path="/" element={guarded(<HomePage />)} />
        <Route path="/problems" element={guarded(<ProblemsPage />)} />
        <Route
          path="/problems/:problemId"
          element={guarded(<ProblemDetailPage config={config} />)}
        />
        <Route path="/deployments" element={guarded(<DeploymentsPage config={config} />)} />
        <Route
          path="/deployments/:jobId"
          element={guarded(<DeploymentDetailPage config={config} />)}
        />
        <Route
          path="/competitor-accounts"
          element={guarded(<CompetitorAccountsPage config={config} />)}
        />
        <Route path="/events" element={guarded(<EventListPage config={config} />)} />
        <Route path="/events/new" element={guarded(<EventCreatePage config={config} />)} />
        <Route path="/events/:eventId" element={guarded(<EventDetailPage config={config} />)} />
        {/* Issue #1292: Tenant Admin 向け audit log view (= 自テナント scope only) */}
        <Route path="/audit-log" element={guarded(<AuditLogPage config={config} />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
