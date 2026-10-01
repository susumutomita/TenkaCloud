import ColumnLayout from "@cloudscape-design/components/column-layout";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import { useT } from "../../i18n";
import {
  getNameErrorText,
  getTeamCountErrorText,
  parseTeamCountInput,
  TEAMS_MAX,
  TEAMS_MIN,
} from "./helpers";

/**
 * 「基本情報」 section: イベント名 + チーム数。
 *
 * チーム数は parent の teamRows 配列長を駆動する numeric input。 parse は
 * `parseTeamCountInput` (clamp + 桁制限) を通すので、 input.value は文字列のまま渡す。
 */
export interface EventCreateBasicInfoSectionProps {
  name: string;
  onNameChange: (next: string) => void;
  nameInvalid: boolean;
  teamCount: number;
  onTeamCountChange: (next: number) => void;
  teamCountInvalid: boolean;
  maxTeams?: number;
}

export function EventCreateBasicInfoSection({
  name,
  onNameChange,
  nameInvalid,
  teamCount,
  onTeamCountChange,
  teamCountInvalid,
  maxTeams = TEAMS_MAX,
}: EventCreateBasicInfoSectionProps) {
  const t = useT();
  return (
    <Container header={<Header variant="h2">{t("event_create.basic_info_header")}</Header>}>
      <ColumnLayout columns={2}>
        <FormField
          label={t("event_create.name_label")}
          description={t("event_create.name_placeholder_example")}
          errorText={getNameErrorText(t, name, nameInvalid)}
        >
          <Input
            value={name}
            onChange={({ detail }) => onNameChange(detail.value)}
            invalid={nameInvalid && name.length > 0}
          />
        </FormField>
        <FormField
          label={t("event_create.team_count_label")}
          description={
            maxTeams > 0
              ? t("event_create.team_count_description", {
                  min: TEAMS_MIN,
                  max: maxTeams,
                })
              : t("event_create.limits_unavailable")
          }
          errorText={
            maxTeams > 0 ? getTeamCountErrorText(t, teamCountInvalid, maxTeams) : undefined
          }
        >
          <Input
            disabled={maxTeams < 1}
            type="number"
            inputMode="numeric"
            value={String(teamCount)}
            onChange={({ detail }) => {
              const next = parseTeamCountInput(detail.value);
              if (next !== undefined) onTeamCountChange(next);
            }}
            invalid={teamCountInvalid}
          />
        </FormField>
      </ColumnLayout>
    </Container>
  );
}
