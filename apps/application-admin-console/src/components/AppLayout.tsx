import AppLayout from "@cloudscape-design/components/app-layout";
import SideNavigation from "@cloudscape-design/components/side-navigation";
import TopNavigation from "@cloudscape-design/components/top-navigation";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

/**
 * application-admin-console の shell。TopNavigation はサインアウトのみ、
 * SideNavigation は ホーム / 問題 (catalog)。今後の PR で「競技イベント」「参加者」等が増える。
 *
 * テナント名は build 時 config.tenantName が pooled stack だと "Shared Pooled Tenant"
 * placeholder のまま漏れるので、ここでは表示しない。Home ページ側で JWT custom 属性
 * (custom:tenantId / 将来 custom:tenantName) からユーザの所属テナントを描画する。
 */
export function ShellLayout({
  config: _config,
  children,
}: {
  config: AppConfig;
  children: ReactNode;
}) {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <>
      <TopNavigation
        identity={{ href: "/", title: "TenkaCloud — Application Console" }}
        utilities={
          auth.tokens
            ? [
                {
                  type: "button",
                  text: "サインアウト",
                  onClick: () => {
                    auth.logout();
                    navigate("/login");
                  },
                },
              ]
            : []
        }
      />
      <AppLayout
        navigation={
          <SideNavigation
            activeHref={location.pathname}
            header={{ href: "/", text: "メニュー" }}
            items={[
              { type: "link", href: "/", text: "ホーム" },
              { type: "link", href: "/problems", text: "問題カタログ" },
              { type: "link", href: "/deployments", text: "デプロイ履歴" },
            ]}
            onFollow={(e) => {
              if (!e.detail.external) {
                e.preventDefault();
                navigate(e.detail.href);
              }
            }}
          />
        }
        content={children}
        toolsHide
      />
    </>
  );
}
