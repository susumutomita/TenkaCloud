import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { HostAuditCollection } from "../../src/api/audit-log-client";
import { AuditCollectionStatus } from "../../src/pages/AuditCollectionStatus";

const collection: HostAuditCollection = {
  enabled: true,
  retentionDays: 30,
  maxRows: 10000,
  missed: 0,
  firstGapAt: null,
  lastGapAt: null,
  discarded: 0,
  gapStatusDurable: true,
};

it.each([
  {
    lang: "en",
    enabled: "Recording enabled",
    stopped: "Recording stopped",
    missing: "Some audit records are missing",
    retention: /30 days/,
    volatile: /held by this process/,
    discarded: /3 old records/,
  },
  {
    lang: "ja",
    enabled: "記録中",
    stopped: "記録を停止しています",
    missing: "監査記録の欠落があります",
    retention: /直近30日/,
    volatile: /現在のプロセスで保持中/,
    discarded: /3件の古い記録/,
  },
])(
  "explains collection state and missing records in $lang",
  ({ lang, enabled, stopped, missing, retention, volatile, discarded }) => {
    const page = render(<AuditCollectionStatus collection={collection} lang={lang} />);
    expect(screen.getByText(enabled)).toBeInTheDocument();
    expect(screen.getByText(retention)).toBeInTheDocument();
    expect(screen.queryByText(missing)).toBeNull();
    page.rerender(
      <AuditCollectionStatus
        collection={{ ...collection, enabled: false, missed: 2, discarded: 3 }}
        lang={lang}
      />,
    );
    expect(screen.getByText(stopped)).toBeInTheDocument();
    expect(screen.getByText(missing)).toBeInTheDocument();
    expect(screen.queryByText(volatile)).toBeNull();
    expect(screen.getByText(discarded)).toBeInTheDocument();
    page.rerender(
      <AuditCollectionStatus
        collection={{ ...collection, missed: 2, gapStatusDurable: false }}
        lang={lang}
      />,
    );
    expect(screen.getByText(volatile)).toBeInTheDocument();
  },
);
