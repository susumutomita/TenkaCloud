import "@cloudscape-design/global-styles/index.css";
import { Navigate, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { ShellLayout } from "./components/AppLayout";
import type { AppConfig } from "./config";
import { AdminDeploymentDetailPage } from "./pages/AdminDeploymentDetail";
import { AdminEventDetailPage } from "./pages/AdminEventDetail";
import { AuditLogPage } from "./pages/AuditLog";
import { CallbackPage } from "./pages/Callback";
import { JobsPage } from "./pages/Jobs";
import { LoginPage } from "./pages/Login";
import { SystemUsersPage } from "./pages/SystemUsers";
import { TenantCreatePage } from "./pages/TenantCreate";
import { TenantEventsPage } from "./pages/TenantEvents";
import { TenantListPage } from "./pages/TenantList";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  if (!auth.ready) return null;
  if (!auth.tokens) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App({ config }: { config: AppConfig }) {
  return (
    <AuthProvider config={config}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/callback" element={<CallbackPage config={config} />} />
        <Route
          path="/tenants"
          element={
            <RequireAuth>
              <ShellLayout>
                <TenantListPage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        <Route
          path="/tenants/new"
          element={
            <RequireAuth>
              <ShellLayout>
                <TenantCreatePage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        {/* Phase 1.B drill-down (ADR-011 / #598) */}
        <Route
          path="/tenants/:tenantId/events"
          element={
            <RequireAuth>
              <ShellLayout>
                <TenantEventsPage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        <Route
          path="/tenants/:tenantId/events/:eventId"
          element={
            <RequireAuth>
              <ShellLayout>
                <AdminEventDetailPage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        <Route
          path="/tenants/:tenantId/deployments/:jobId"
          element={
            <RequireAuth>
              <ShellLayout>
                <AdminDeploymentDetailPage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        <Route
          path="/jobs"
          element={
            <RequireAuth>
              <ShellLayout>
                <JobsPage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        {/* Issue #949 (ADR-020 Phase C): SystemAdmin user 管理 */}
        <Route
          path="/settings/system-users"
          element={
            <RequireAuth>
              <ShellLayout>
                <SystemUsersPage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        {/* Issue #950 (ADR-020 Phase D): admin audit log */}
        <Route
          path="/audit-log"
          element={
            <RequireAuth>
              <ShellLayout>
                <AuditLogPage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/tenants" replace />} />
      </Routes>
    </AuthProvider>
  );
}
