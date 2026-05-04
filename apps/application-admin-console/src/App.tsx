import "@cloudscape-design/global-styles/index.css";
import { Navigate, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { ShellLayout } from "./components/AppLayout";
import type { AppConfig } from "./config";
import { AppNewPage } from "./pages/AppNew";
import { AppsPage } from "./pages/Apps";
import { CallbackPage } from "./pages/Callback";
import { HomePage } from "./pages/Home";
import { LoginPage } from "./pages/Login";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  if (!auth.ready) return null;
  if (!auth.tokens) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function guarded(config: AppConfig, element: React.ReactNode) {
  return (
    <RequireAuth>
      <ShellLayout config={config}>{element}</ShellLayout>
    </RequireAuth>
  );
}

export function App({ config }: { config: AppConfig }) {
  return (
    <AuthProvider config={config}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/callback" element={<CallbackPage config={config} />} />
        <Route path="/" element={guarded(config, <HomePage config={config} />)} />
        <Route path="/apps" element={guarded(config, <AppsPage config={config} />)} />
        <Route path="/apps/new" element={guarded(config, <AppNewPage config={config} />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
