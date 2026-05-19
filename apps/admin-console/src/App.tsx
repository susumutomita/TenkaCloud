import "@cloudscape-design/global-styles/index.css";
import { Navigate, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { ShellLayout } from "./components/AppLayout";
import type { AppConfig } from "./config";
import { AuditLogPage } from "./pages/AuditLog";
import { CallbackPage } from "./pages/Callback";
import { JobsPage } from "./pages/Jobs";
import { LoginPage } from "./pages/Login";
import { OperationsPage } from "./pages/Operations";
import { TenantCreatePage } from "./pages/TenantCreate";
import { TenantDetailPage } from "./pages/TenantDetail";
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
        {/* Tenant detail (= Control Plane metadata のみ。 App Plane data drill-down は plane
            分離方針で除去、 [[feedback-no-cross-plane-data-leak]])。 */}
        <Route
          path="/tenants/:tenantId"
          element={
            <RequireAuth>
              <ShellLayout>
                <TenantDetailPage config={config} />
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
        {/* SystemAdmin user 管理 page は廃止 (2026-05-18)。 token を扱う UI 経路は security
            hole になりやすく、 plane 境界も曖昧になるため、 SystemAdmin 招待は Cognito 直
            (= aws cognito-idp admin-create-user / Hosted UI) に倒した。 audit は別 page で
            残す ([[feedback-no-cross-plane-data-leak]])。 */}
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
        {/* Issue #1080: 運用ダッシュボード (CloudWatch / Budgets / Alarms へのリンク集) */}
        <Route
          path="/operations"
          element={
            <RequireAuth>
              <ShellLayout>
                <OperationsPage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/tenants" replace />} />
      </Routes>
    </AuthProvider>
  );
}
