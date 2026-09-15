import Alert from "@cloudscape-design/components/alert";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import FormField from "@cloudscape-design/components/form-field";
import Header from "@cloudscape-design/components/header";
import Input from "@cloudscape-design/components/input";
import Select from "@cloudscape-design/components/select";
import SpaceBetween from "@cloudscape-design/components/space-between";
import Textarea from "@cloudscape-design/components/textarea";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { canMutateTenant, useApiClient } from "../api/client";
import { createEvent } from "../api/events-client";
import type { AppConfig } from "../config";

interface Choice { problemId: string; name: string; runtime: string }

export function HostEventCreate({ config }: { config: AppConfig }) {
  const api = useApiClient(config);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [teams, setTeams] = useState("team-a\nteam-b");
  const [choices, setChoices] = useState<Choice[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(
    () => {
      let active = true;
      if (api) void api.get<{ items: Choice[] }>("host/catalog").then(value => {
        if (!active) return;
        setChoices(value.items);
        setSelected(value.items[0]?.problemId ?? "");
      }).catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : "問題一覧を取得できませんでした。");
      });
      return () => {
        active = false;
      };
    },
    [api]
  );
  const slugs = teams.split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  const valid = name.trim().length > 0 && name.length <= 120 && slugs.length > 0 && slugs.length <= 40
    && new Set(slugs).size === slugs.length && slugs.every(value => /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u.test(value)) && !!selected;
  async function create(): Promise<void> {
    if (!api || !valid) return;
    setBusy(true);
    setError("");
    try {
      const result = await createEvent(
        api,
        {
          name: name.trim(),
          teams: slugs.map(internalSlug => ({ internalSlug })),
          problems: [{ problemId: selected, defaultRegion: "local" }]
        }
      );
      navigate(`/events/${result.eventId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "イベント作成に失敗しました。");
    }
    finally {
      setBusy(false);
    }
  }
  const option = choices.find(choice => choice.problemId === selected);
  return <Container header={<Header variant="h2">イベントを作成</Header>}><SpaceBetween size="l">
    {error && <Alert type="error">{error}</Alert>}
    <FormField label="イベント名"><Input value={name} onChange={({ detail }) => setName(detail.value)} /></FormField>
    <FormField
      label="チーム（1行に1チーム）"
      description="半角小文字・数字・ハイフンで指定。参加キーはチームごとに発行されます。"><Textarea
        value={teams}
        onChange={({ detail }) => setTeams(detail.value)}
        rows={5} /></FormField>
    <FormField label="問題"><Select
      selectedOption={option ? { value: option.problemId, label: option.name } : null}
      options={choices.map(choice => ({ value: choice.problemId, label: choice.name }))}
      onChange={({ detail }) => setSelected(detail.selectedOption.value ?? "")} /></FormField>
    <Alert type="info">本体の起動・イベント作成にはDockerは不要です。この問題の環境準備にはDocker Composeを使い、チームごとに独立した環境を作成します。</Alert>
    <Button
      variant="primary"
      loading={busy}
      disabled={!valid || !canMutateTenant(api)}
      onClick={() => void create()}>イベントを作成</Button>
  </SpaceBetween></Container>;
}
