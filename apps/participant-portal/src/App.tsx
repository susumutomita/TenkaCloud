import "@cloudscape-design/global-styles/index.css";
import { Navigate, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { ShellLayout } from "./components/AppLayout";
import type { AppConfig } from "./config";
import { HomePage } from "./pages/Home";
import { LoginPage } from "./pages/Login";
import { PlaceholderPage } from "./pages/Placeholder";
import { ScoreboardPage } from "./pages/Scoreboard";
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
          element={guarded(
            config,
            <PlaceholderPage
              title="Score events"
              description="自チーム + 全体の得点履歴"
              comingSoon="scoring backend を別 PR で接続後、ここに時刻 / source / 説明 / points の履歴が表示されます。"
            />,
          )}
        />
        <Route
          path="/notifications"
          element={guarded(
            config,
            <PlaceholderPage
              title="Notifications"
              description="運営からの通知"
              comingSoon="運営者が application admin console から発信した通知をここに表示します。"
            />,
          )}
        />
        <Route
          path="/problems"
          element={guarded(
            config,
            <PlaceholderPage
              title="問題一覧 (Quests)"
              description="自チームに deploy された問題の入口"
              comingSoon="deploy backend が完成すると、自チーム向けに deploy 済みの問題 (URL / API URL) がここに並びます。"
            />,
          )}
        />
        <Route
          path="/problems/:problemId"
          element={guarded(
            config,
            <PlaceholderPage
              title="問題ダッシュボード"
              description="Battle / Challenge の状態 + 操作 UI"
              comingSoon="Battle: Attack Statistics / Application Status / Attack History の 3 タブを後段 PR で実装します。"
            />,
          )}
        />
        <Route
          path="/tools/sso"
          element={guarded(
            config,
            <PlaceholderPage
              title="SSO Credentials"
              description="AWS Console へのサインイン情報"
              comingSoon="チーム単位の Identity Center 認証情報をここに表示します。発行は deploy backend 側。"
            />,
          )}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
