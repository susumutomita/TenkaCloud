import { describe, expect, it } from "vitest";

// SBT 0.3.9 ベースの新スタックは synth 時に Lambda asset bundling のため docker を要求するので
// instantiation テストは local docker 必須となり CI で動かない。
// 代替として「export 済 symbol が undefined ではない」だけ確認するスモークテストを置き、
// 少なくとも tsc/import エラーは CI で気付けるようにする。
describe("server/lib new CDK stacks (SBT 0.3.9) imports", () => {
  it("ControlPlaneStack を import できるべき", async () => {
    const { ControlPlaneStack } = await import("../lib/control-plane-stack");
    expect(ControlPlaneStack).toBeDefined();
  });

  it("BootstrapTemplateStack を import できるべき", async () => {
    const { BootstrapTemplateStack } = await import("../lib/bootstrap-template/bootstrap-template-stack");
    expect(BootstrapTemplateStack).toBeDefined();
  });

  it("TenantTemplateStack を import できるべき", async () => {
    const { TenantTemplateStack } = await import("../lib/tenant-template/tenant-template-stack");
    expect(TenantTemplateStack).toBeDefined();
  });

  it("ServerlessSaaSPipeline を import できるべき", async () => {
    const { ServerlessSaaSPipeline } = await import("../lib/tenant-pipeline/serverless-saas-pipeline");
    expect(ServerlessSaaSPipeline).toBeDefined();
  });

  it("AdminConsoleHostingStack を import できるべき", async () => {
    const { AdminConsoleHostingStack } = await import("../lib/admin-console-hosting");
    expect(AdminConsoleHostingStack).toBeDefined();
  });
});
