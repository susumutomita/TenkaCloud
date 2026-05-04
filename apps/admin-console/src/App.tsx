import "@cloudscape-design/global-styles/index.css";
import { Navigate, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { ShellLayout } from "./components/AppLayout";
import type { AppConfig } from "./config";
import { CallbackPage } from "./pages/Callback";
import { LoginPage } from "./pages/Login";
import { TenantCreatePage } from "./pages/TenantCreate";
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
        <Route path="*" element={<Navigate to="/tenants" replace />} />
      </Routes>
    </AuthProvider>
  );
}
