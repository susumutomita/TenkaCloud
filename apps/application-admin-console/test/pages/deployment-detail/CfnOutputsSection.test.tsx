import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CfnOutputsSection } from "../../../src/pages/deployment-detail/CfnOutputsSection";

const t = (key: string) => key;

describe("CfnOutputsSection", () => {
  it("should render each CFn output as a label/value pair", () => {
    render(
      <CfnOutputsSection
        outputs={{ SiteUrl: "https://x", RoleArn: "arn:aws:iam::1:role/x" }}
        t={t}
      />,
    );
    expect(screen.getByText("deployment_detail.cfn_outputs_header")).toBeInTheDocument();
    expect(screen.getByText("SiteUrl")).toBeInTheDocument();
    expect(screen.getByText("https://x")).toBeInTheDocument();
    expect(screen.getByText("arn:aws:iam::1:role/x")).toBeInTheDocument();
  });

  it("should render no pairs for empty outputs", () => {
    render(<CfnOutputsSection outputs={{}} t={t} />);
    expect(screen.getByText("deployment_detail.cfn_outputs_header")).toBeInTheDocument();
  });
});
