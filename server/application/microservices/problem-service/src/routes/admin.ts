/**
 * 管理画面API
 *
 * - イベント CRUD
 * - 問題 CRUD
 * - コンテスト開始/停止
 * - チーム管理
 * - ダッシュボード（管理者ビュー）
 */

import { createAdminRouter } from "./admin-shared";
import { eventRoutes } from "./admin-events";
import { problemRoutes } from "./admin-problems";
import { importExportRoutes } from "./admin-import-export";
import { contestRoutes } from "./admin-contests";
import { teamRoutes } from "./admin-teams";
import { dashboardRoutes } from "./admin-dashboard";
import { templateRoutes } from "./admin-templates";
import { aiRoutes } from "./admin-ai";
import { deployRoutes } from "./admin-deploy";
import { gamedayDeployRoutes } from "./admin-gameday-deploy";

const adminRouter = createAdminRouter();

// サブルーターをマウント
adminRouter.route("/", eventRoutes);
adminRouter.route("/", problemRoutes);
adminRouter.route("/", importExportRoutes);
adminRouter.route("/", contestRoutes);
adminRouter.route("/", teamRoutes);
adminRouter.route("/", dashboardRoutes);
adminRouter.route("/", templateRoutes);
adminRouter.route("/", aiRoutes);
adminRouter.route("/", deployRoutes);
adminRouter.route("/", gamedayDeployRoutes);

export { adminRouter };
