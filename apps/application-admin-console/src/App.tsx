import "@cloudscape-design/global-styles/index.css";
import { Navigate, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { ShellLayout } from "./components/AppLayout";
import type { AppConfig } from "./config";
import { CallbackPage } from "./pages/Callback";
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
        <Route path="/" element={guarded(config, <HomePage />)} />
        <Route path="/problems" element={guarded(config, <ProblemsPage />)} />
        <Route
          path="/problems/:problemId"
          element={guarded(config, <ProblemDetailPage config={config} />)}
        />
        <Route path="/deployments" element={guarded(config, <DeploymentsPage config={config} />)} />
        <Route
          path="/deployments/:jobId"
          element={guarded(config, <DeploymentDetailPage config={config} />)}
        />
        <Route path="/events" element={guarded(config, <EventListPage config={config} />)} />
        <Route path="/events/new" element={guarded(config, <EventCreatePage config={config} />)} />
        <Route
          path="/events/:eventId"
          element={guarded(config, <EventDetailPage config={config} />)}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
