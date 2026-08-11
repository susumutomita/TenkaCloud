import "@cloudscape-design/global-styles/index.css";
import { Navigate, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { ShellLayout } from "./components/AppLayout";
import type { AppConfig } from "./config";
import { AuditLogPage } from "./pages/AuditLog";
import { CallbackPage } from "./pages/Callback";
import { IdentityProvidersPage } from "./pages/IdentityProviders";
import { JobsPage } from "./pages/Jobs";
import { LoginPage } from "./pages/Login";
import { OperationsPage } from "./pages/Operations";
import { TenantCreatePage } from "./pages/TenantCreate";
import { TenantDetailPage } from "./pages/TenantDetail";
import { TenantListPage } from "./pages/TenantList";
import { UsagePage } from "./pages/Usage";

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
        <Route path="/login" element={<LoginPage config={config} />} />
        <Route path="/callback" element={<CallbackPage config={config} />} />
        <Route
          path="/tenants"
          element={
            <RequireAuth>
              <ShellLayout samlSsoEnabled={config.features?.samlSso}>
                <TenantListPage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        <Route
          path="/tenants/new"
          element={
            <RequireAuth>
              <ShellLayout samlSsoEnabled={config.features?.samlSso}>
                <TenantCreatePage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        {/* Tenant detail (= Control Plane metadata のみ。App Plane data は表示しない)。 */}
        <Route
          path="/tenants/:tenantId"
          element={
            <RequireAuth>
              <ShellLayout samlSsoEnabled={config.features?.samlSso}>
                <TenantDetailPage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        {/* Issue #1767: tenant usage dashboard (既存 AdminInsight データの可視化) */}
        <Route
          path="/usage"
          element={
            <RequireAuth>
              <ShellLayout samlSsoEnabled={config.features?.samlSso}>
                <UsagePage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        <Route
          path="/jobs"
          element={
            <RequireAuth>
              <ShellLayout samlSsoEnabled={config.features?.samlSso}>
                <JobsPage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        {/* SystemAdmin user 管理 page は廃止 (2026-05-18)。 token を扱う UI 経路は security
            hole になりやすく、 plane 境界も曖昧になるため、 SystemAdmin 招待は Cognito 直
            (= aws cognito-idp admin-create-user / Hosted UI) に倒した。 audit は別 page で
            残す。 */}
        {/* Issue #950: admin audit log */}
        <Route
          path="/audit-log"
          element={
            <RequireAuth>
              <ShellLayout samlSsoEnabled={config.features?.samlSso}>
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
              <ShellLayout samlSsoEnabled={config.features?.samlSso}>
                <OperationsPage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        {/* Issue #1293: SAML IdP CRUD for Control Plane Cognito UserPool */}
        <Route
          path="/identity-providers"
          element={
            <RequireAuth>
              <ShellLayout samlSsoEnabled={config.features?.samlSso}>
                <IdentityProvidersPage config={config} />
              </ShellLayout>
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/tenants" replace />} />
      </Routes>
    </AuthProvider>
  );
}
