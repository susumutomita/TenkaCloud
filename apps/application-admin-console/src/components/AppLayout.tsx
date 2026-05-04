import AppLayout from "@cloudscape-design/components/app-layout";
import SideNavigation from "@cloudscape-design/components/side-navigation";
import TopNavigation from "@cloudscape-design/components/top-navigation";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import type { AppConfig } from "../config";

/**
 * application-admin-console の shell。TopNavigation にサインアウトボタンと
 * テナント名、SideNavigation に /（ホーム）と /apps（公開アプリ）を並べる。
 *
 * TopNavigation の identity title に「Application Admin Console — <tenantName>」と
 * テナント名を入れて、複数テナントを行き来する人 (運営者) が画面の所属を即座に
 * 区別できるようにする。
 */
export function ShellLayout({ config, children }: { config: AppConfig; children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <>
      <TopNavigation
        identity={{ href: "/", title: `Application Admin Console — ${config.tenantName}` }}
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
              { type: "link", href: "/apps", text: "公開アプリ" },
              { type: "link", href: "/apps/new", text: "アプリを公開する" },
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
