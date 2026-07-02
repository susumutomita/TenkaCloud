import "@cloudscape-design/global-styles/index.css";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { DemoSessionBootstrap } from "./auth/demo-session";
import { buildLoginReturnPath, readLoginReturnPathState } from "./auth/login-return-path";
import { ShellLayout } from "./components/AppLayout";
import type { AppConfig } from "./config";
import { useEffectiveFeatures } from "./hooks/useEffectiveFeatures";
import { AuditLogPage } from "./pages/AuditLog";
import { CallbackPage } from "./pages/Callback";
import { CompetitorAccountsPage } from "./pages/CompetitorAccounts";
import { DeploymentDetailPage } from "./pages/DeploymentDetail";
import { DeploymentsPage } from "./pages/Deployments";
import { EventCreatePage } from "./pages/EventCreate";
import { EventDetailPage } from "./pages/EventDetail";
import { EventListPage } from "./pages/EventList";
import { EventReportPage } from "./pages/EventReport";
import { HomePage } from "./pages/Home";
import { IdentityProvidersPage } from "./pages/IdentityProviders";
import { LoginPage } from "./pages/Login";
import { ProblemDetailPage } from "./pages/ProblemDetail";
import { ProblemsPage } from "./pages/Problems";
import { SettingsPage } from "./pages/Settings";
import { TenantUsersPage } from "./pages/TenantUsers";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  if (!auth.ready) return null;
  if (!auth.tokens) {
    return <Navigate to="/login" replace state={{ returnPath: buildLoginReturnPath(location) }} />;
  }
  return <>{children}</>;
}

function guarded(element: React.ReactNode, config: AppConfig) {
  return (
    <RequireAuth>
      <ShellLayout
        samlSsoEnabled={config.features?.samlSso}
        demoMode={config.mode === "demo"}
        // The banner only renders the link when demoMode is true, so passing the URL
        // unconditionally is safe (and avoids an untested non-demo ternary branch).
        demoParticipantUrl={config.participantPortalUrl}
      >
        {element}
      </ShellLayout>
    </RequireAuth>
  );
}

function LoginRoute({ config }: { config: AppConfig }) {
  const location = useLocation();
  return <LoginPage config={config} returnPath={readLoginReturnPathState(location.state)} />;
}

export function App({ config }: { config: AppConfig }) {
  return (
    <AuthProvider config={config}>
      {/* Issue #1954: demo mode は Cognito をスキップして mock session を注入する。 */}
      <DemoSessionBootstrap config={config} />
      <AppRoutes baseConfig={config} />
    </AuthProvider>
  );
}

/**
 * Issue #2231: `useEffectiveFeatures` must run inside `<AuthProvider>` (it calls
 * `useApiClient` → `useAuth`), so the route tree — and the `config` object every page
 * reads `config.features` from — is split into this child component rather than living
 * directly in `App`.
 */
function AppRoutes({ baseConfig }: { baseConfig: AppConfig }) {
  const features = useEffectiveFeatures(baseConfig);
  const config: AppConfig = { ...baseConfig, features };

  return (
    <Routes>
      <Route path="/login" element={<LoginRoute config={config} />} />
      <Route path="/callback" element={<CallbackPage config={config} />} />
      <Route path="/" element={guarded(<HomePage />, config)} />
      <Route path="/problems" element={guarded(<ProblemsPage />, config)} />
      <Route
        path="/problems/:problemId"
        element={guarded(<ProblemDetailPage config={config} />, config)}
      />
      <Route path="/deployments" element={guarded(<DeploymentsPage config={config} />, config)} />
      <Route
        path="/deployments/:jobId"
        element={guarded(<DeploymentDetailPage config={config} />, config)}
      />
      <Route
        path="/competitor-accounts"
        element={guarded(<CompetitorAccountsPage config={config} />, config)}
      />
      <Route path="/events" element={guarded(<EventListPage config={config} />, config)} />
      <Route path="/events/new" element={guarded(<EventCreatePage config={config} />, config)} />
      <Route
        path="/events/:eventId"
        element={guarded(<EventDetailPage config={config} />, config)}
      />
      {/* PR-1191: print-friendly Event Report deliverable for Hosted / Annual Arena. */}
      <Route
        path="/events/:eventId/report"
        element={guarded(<EventReportPage config={config} />, config)}
      />
      {/* Issue #1292: Tenant Admin 向け audit log view (= 自テナント scope only) */}
      <Route path="/audit-log" element={guarded(<AuditLogPage config={config} />, config)} />
      <Route path="/users" element={guarded(<TenantUsersPage config={config} />, config)} />
      {/* Issue #2231: per-tenant runtime feature-flag toggle. */}
      <Route path="/settings" element={guarded(<SettingsPage config={config} />, config)} />
      {/* Issue #1294: Tenant SAML SSO IdP CRUD (silo tier only) */}
      <Route
        path="/identity-providers"
        element={guarded(<IdentityProvidersPage config={config} />, config)}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
