import { Navigate } from "react-router";
import { useAuth } from "./AuthProvider";

/**
 * 認証 guard。 session が無ければ `/login` へ、 backend モードで team 名未設定なら
 * `/setup` へ誘導する。
 *
 * #2707: dev-mock の `?demo=1` deep link (LP hero 「始める」 → `/start` 等) では
 * auto-login が非同期に完了するため、 完了前に redirect すると deep link の行き先が
 * 失われる。 `demoLoginPending` の間は redirect せずに待つ。
 */
export function RequireAuth({
  requireTeamName,
  children,
}: {
  requireTeamName: boolean;
  children: React.ReactNode;
}) {
  const auth = useAuth();
  if (!auth.ready) return null;
  if (!auth.session) {
    if (auth.demoLoginPending) return null;
    return <Navigate to="/login" replace />;
  }
  // backend モードで、まだチーム名を設定していない競技者は /setup に誘導する。
  if (requireTeamName && !auth.session.teamNameSetByCompetitor) {
    return <Navigate to="/setup" replace />;
  }
  return <>{children}</>;
}
