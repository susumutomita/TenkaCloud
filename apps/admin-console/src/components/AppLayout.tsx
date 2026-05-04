import AppLayout from "@cloudscape-design/components/app-layout";
import SideNavigation from "@cloudscape-design/components/side-navigation";
import TopNavigation from "@cloudscape-design/components/top-navigation";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";

export function ShellLayout({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <>
      <TopNavigation
        identity={{ href: "/", title: "TenkaCloud Admin Console" }}
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
            header={{ href: "/", text: "管理メニュー" }}
            items={[
              { type: "link", href: "/tenants", text: "テナント一覧" },
              { type: "link", href: "/tenants/new", text: "テナント作成" },
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
