import "@cloudscape-design/global-styles/index.css";
import { Navigate, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { ShellLayout } from "./components/AppLayout";
import type { AppConfig } from "./config";
import { HomePage } from "./pages/Home";
import { LoginPage } from "./pages/Login";
import { NotificationsPage } from "./pages/Notifications";
import { ProblemDetailPage } from "./pages/ProblemDetail";
import { QuestsPage } from "./pages/Quests";
import { ScoreboardPage } from "./pages/Scoreboard";
import { ScoreEventsPage } from "./pages/ScoreEvents";
import { SsoCredentialsPage } from "./pages/SsoCredentials";
import { TeamSetupPage } from "./pages/TeamSetup";

function RequireAuth({
  requireTeamName,
  children,
}: {
  requireTeamName: boolean;
  children: React.ReactNode;
}) {
  const auth = useAuth();
  if (!auth.ready) return null;
  if (!auth.session) return <Navigate to="/login" replace />;
  // backend モードで、まだチーム名を設定していない競技者は /setup に誘導する。
  if (requireTeamName && !auth.session.teamNameSetByCompetitor) {
    return <Navigate to="/setup" replace />;
  }
  return <>{children}</>;
}

function guarded(config: AppConfig, element: React.ReactNode) {
  return (
    <RequireAuth requireTeamName>
      <ShellLayout config={config}>{element}</ShellLayout>
    </RequireAuth>
  );
}

export function App({ config }: { config: AppConfig }) {
  return (
    <AuthProvider config={config}>
      <Routes>
        <Route path="/login" element={<LoginPage config={config} />} />
        <Route
          path="/setup"
          element={
            <RequireAuth requireTeamName={false}>
              <TeamSetupPage config={config} />
            </RequireAuth>
          }
        />
        <Route path="/" element={guarded(config, <HomePage config={config} />)} />
        <Route path="/scoreboard" element={guarded(config, <ScoreboardPage config={config} />)} />
        <Route
          path="/score-events"
          element={guarded(config, <ScoreEventsPage config={config} />)}
        />
        <Route
          path="/notifications"
          element={guarded(config, <NotificationsPage config={config} />)}
        />
        <Route path="/problems" element={guarded(config, <QuestsPage config={config} />)} />
        <Route
          path="/problems/:jobId"
          element={guarded(config, <ProblemDetailPage config={config} />)}
        />
        <Route
          path="/tools/sso"
          element={guarded(config, <SsoCredentialsPage config={config} />)}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
