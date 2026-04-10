/**
 * Admin Event Create Page
 *
 * Cloudscape Design System — イベント新規作成
 */

'use client';

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useRouter } from 'next/navigation';

import { post } from '@/lib/api/client';

import {
  buildPayload,
  CLOUD_PROVIDER_OPTIONS,
  PARTICIPANT_TYPE_OPTIONS,
  SCORING_TYPE_OPTIONS,
  STATUS_OPTIONS,
  TIMEZONE_OPTIONS,
  TYPE_OPTIONS,
  useEventFormState,
} from '../use-event-form-state';

export default function AdminEventCreatePage() {
  const router = useRouter();
  const { form, errors, submitting, serverError, setField, submit } =
    useEventFormState();

  const handleSubmit = async () => {
    const ok = await submit(() => post('/admin/events', buildPayload(form)));
    if (ok) router.push('/admin/events');
  };

  return (
    <Form
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <Button variant="link" onClick={() => router.push('/admin/events')}>
            キャンセル
          </Button>
          <Button variant="primary" loading={submitting} onClick={handleSubmit}>
            作成
          </Button>
        </SpaceBetween>
      }
      header={<Header variant="h1">イベント作成</Header>}
      errorText={serverError ?? undefined}
    >
      <Container header={<Header variant="h2">基本情報</Header>}>
        <SpaceBetween size="l">
          <FormField
            label="イベント名"
            errorText={errors.name}
            constraintText="必須"
          >
            <Input
              value={form.name}
              onChange={({ detail }) => setField('name', detail.value)}
              placeholder="例: クラウドチャレンジ 2026 春"
            />
          </FormField>
          <SpaceBetween direction="horizontal" size="l">
            <FormField label="タイプ">
              <Select
                selectedOption={form.type}
                onChange={({ detail }) =>
                  setField('type', detail.selectedOption)
                }
                options={TYPE_OPTIONS}
              />
            </FormField>
            <FormField label="ステータス">
              <Select
                selectedOption={form.status}
                onChange={({ detail }) =>
                  setField('status', detail.selectedOption)
                }
                options={STATUS_OPTIONS}
              />
            </FormField>
          </SpaceBetween>
          <SpaceBetween direction="horizontal" size="l">
            <FormField label="開始日時">
              <input
                type="datetime-local"
                value={form.startTime}
                onChange={(event) => setField('startTime', event.target.value)}
                placeholder="YYYY-MM-DDTHH:mm"
                className="awsui-input-type-text"
              />
            </FormField>
            <FormField label="終了日時" errorText={errors.endTime}>
              <input
                type="datetime-local"
                value={form.endTime}
                onChange={(event) => setField('endTime', event.target.value)}
                placeholder="YYYY-MM-DDTHH:mm"
                className="awsui-input-type-text"
              />
            </FormField>
          </SpaceBetween>
          <FormField label="タイムゾーン">
            <Select
              selectedOption={form.timezone}
              onChange={({ detail }) =>
                setField('timezone', detail.selectedOption)
              }
              options={TIMEZONE_OPTIONS}
            />
          </FormField>
        </SpaceBetween>
      </Container>
      <Box margin={{ top: 'l' }}>
        <Container header={<Header variant="h2">参加設定</Header>}>
          <SpaceBetween size="l">
            <SpaceBetween direction="horizontal" size="l">
              <FormField label="参加形式">
                <Select
                  selectedOption={form.participantType}
                  onChange={({ detail }) =>
                    setField('participantType', detail.selectedOption)
                  }
                  options={PARTICIPANT_TYPE_OPTIONS}
                />
              </FormField>
              <FormField label="クラウドプロバイダー">
                <Select
                  selectedOption={form.cloudProvider}
                  onChange={({ detail }) =>
                    setField('cloudProvider', detail.selectedOption)
                  }
                  options={CLOUD_PROVIDER_OPTIONS}
                />
              </FormField>
            </SpaceBetween>
            <SpaceBetween direction="horizontal" size="l">
              <FormField label="最大参加者数">
                <Input
                  type="number"
                  value={form.maxParticipants}
                  onChange={({ detail }) =>
                    setField('maxParticipants', detail.value)
                  }
                  inputMode="numeric"
                />
              </FormField>
              <FormField label="採点方式">
                <Select
                  selectedOption={form.scoringType}
                  onChange={({ detail }) =>
                    setField('scoringType', detail.selectedOption)
                  }
                  options={SCORING_TYPE_OPTIONS}
                />
              </FormField>
            </SpaceBetween>
          </SpaceBetween>
        </Container>
      </Box>
    </Form>
  );
}
