import "@cloudscape-design/global-styles/index.css";
import { Navigate, Route, Routes } from "react-router";
import { AuthProvider } from "./auth/AuthProvider";
import { RequireAuth } from "./auth/RequireAuth";
import { ShellLayout } from "./components/AppLayout";
import type { AppConfig } from "./config";
import { CourseTracksPage } from "./pages/CourseTracks";
import { CryptoDrillPage } from "./pages/CryptoDrill";
import { LoginPage } from "./pages/Login";
import { NotificationsPage } from "./pages/Notifications";
import { ProblemDetailPage } from "./pages/ProblemDetail";
import { QuestsPage } from "./pages/Quests";
import { RootEntryPage } from "./pages/RootEntry";
import { ScoreboardPage } from "./pages/Scoreboard";
import { ScoreEventsPage } from "./pages/ScoreEvents";
import { SsoCredentialsPage } from "./pages/SsoCredentials";
import { StartPage } from "./pages/Start";
import { TeamSetupPage } from "./pages/TeamSetup";

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
        {/* #2711: `?goto=start` 付きの実ファイル着地 (LP hero カード) を /start へ流す。 */}
        <Route path="/" element={guarded(config, <RootEntryPage config={config} />)} />
        {/* #2707 P0-5: オンボーディング開始点。 表示順で最初の未得点問題へ直行する。 */}
        <Route path="/start" element={guarded(config, <StartPage />)} />
        <Route path="/scoreboard" element={guarded(config, <ScoreboardPage config={config} />)} />
        <Route
          path="/score-events"
          element={guarded(config, <ScoreEventsPage config={config} />)}
        />
        <Route path="/notifications" element={guarded(config, <NotificationsPage />)} />
        <Route path="/problems" element={guarded(config, <QuestsPage />)} />
        {/* Issue #2786: 週・章順の学習経路。 /problems の flat 一覧と併存する。 */}
        <Route path="/course-tracks" element={guarded(config, <CourseTracksPage />)} />
        {/* AWS を 1 つも deploy していなくても進められる学習ドリル。 */}
        <Route path="/learn/sha256" element={guarded(config, <CryptoDrillPage />)} />
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
