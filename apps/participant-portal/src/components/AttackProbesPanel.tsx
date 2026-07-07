import Box from "@cloudscape-design/components/box";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import StatusIndicator from "@cloudscape-design/components/status-indicator";
import type { ParticipantProblemView } from "../api/portal-client";
import {
  describeAttackProbe,
  type ProblemPanelT,
  summarizeAttackProbes,
} from "./ProblemPanel.helpers";

/**
 * Issue #2422: uptime-multi Battle の直近サイクル attack-probe 結果を描画する。 defender が
 * 「green (200) なのに満点にならない理由」= まだ刺さっている probe と、 このサイクルの減点量を
 * 一目で把握できる。 非スポイラー: 出すのは問題側 metadata が開示した label / symptom と
 * outcome / 減点量のみ (= 正確な endpoint / 脆弱性クラスは backend snapshot に含まれない)。
 */
export function AttackProbesPanel({
  status,
  t,
}: {
  status: NonNullable<ParticipantProblemView["attackProbeStatus"]>;
  t: ProblemPanelT;
}) {
  const summary = summarizeAttackProbes(status.probes, t);
  return (
    <Container
      header={
        <Header
          variant="h3"
          actions={<StatusIndicator type={summary.type}>{summary.label}</StatusIndicator>}
        >
          {t("problem_panel.attack_probes_header")}
        </Header>
      }
    >
      <SpaceBetween size="xs">
        <Box variant="small" color="text-body-secondary">
          {t("problem_panel.attack_probes_intro")}
        </Box>
        {status.probes.map((probe, index) => {
          const row = describeAttackProbe(probe, index, t);
          // key は content 由来で組む (= array index を key にしない)。 unnamed probe は
          // describeAttackProbe が index 由来の名前で一意化するので name+outcome で衝突しない。
          return (
            <Box key={`${row.name}-${probe.outcome}`}>
              <StatusIndicator type={row.type}>
                {row.name} — {row.outcomeLabel}
              </StatusIndicator>
              {row.symptom && (
                <Box variant="small" color="text-status-inactive" margin={{ left: "l" }}>
                  {row.symptom}
                </Box>
              )}
            </Box>
          );
        })}
      </SpaceBetween>
    </Container>
  );
}
