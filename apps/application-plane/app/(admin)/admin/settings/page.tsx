/**
 * Admin Settings Page
 *
 * Cloudscape Design System
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import Button from '@cloudscape-design/components/button';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Tabs from '@cloudscape-design/components/tabs';
import Modal from '@cloudscape-design/components/modal';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Box from '@cloudscape-design/components/box';
import Alert from '@cloudscape-design/components/alert';
import { get, put, post } from '@/lib/api/client';

interface SettingsData {
  tenantName: string;
  slug: string;
  apiKey: string;
}

function maskApiKey(key: string): string {
  if (!key || key.length < 8) return key || '';
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

export default function AdminSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>(
    'idle'
  );
  const [saveError, setSaveError] = useState('');
  const [activeTabId, setActiveTabId] = useState('general');
  const [tenantName, setTenantName] = useState('');
  const [slug, setSlug] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [copied, setCopied] = useState(false);
  const [regenerateModalVisible, setRegenerateModalVisible] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const fetchSettings = useCallback(async () => {
    try {
      setLoading(true);
      const data = await get<SettingsData>('/admin/settings');
      setTenantName(data.tenantName || '');
      setSlug(data.slug || '');
      setApiKey(data.apiKey || '');
    } catch {
      // defaults
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus('idle');
    setSaveError('');
    try {
      const data = await put<SettingsData>('/admin/settings', {
        tenantName,
        slug,
      });
      setTenantName(data.tenantName || tenantName);
      setSlug(data.slug || slug);
      setSaveStatus('success');
      window.setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (err) {
      setSaveStatus('error');
      setSaveError(
        err instanceof Error ? err.message : '設定の保存に失敗しました'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleCopyApiKey = async () => {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* noop */
    }
  };

  const handleRegenerateApiKey = async () => {
    setRegenerating(true);
    try {
      const data = await post<SettingsData>('/admin/settings', {
        action: 'regenerate-api-key',
      });
      setApiKey(data.apiKey || '');
      setRegenerateModalVisible(false);
    } catch {
      /* noop */
    } finally {
      setRegenerating(false);
    }
  };

  const handleDeleteAllData = async () => {
    setDeleting(true);
    setDeleteError('');
    try {
      await post('/admin/settings', {
        action: 'delete-all-data',
        confirmationToken: deleteConfirmation,
      });
      setDeleteModalVisible(false);
      setDeleteConfirmation('');
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : 'データの削除に失敗しました'
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <SpaceBetween size="l">
      <Header variant="h1">設定</Header>
      <Tabs
        activeTabId={activeTabId}
        onChange={({ detail }) => setActiveTabId(detail.activeTabId)}
        tabs={[
          {
            id: 'general',
            label: '一般設定',
            content: (
              <Form
                actions={
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button
                      variant="primary"
                      onClick={handleSave}
                      loading={saving}
                      disabled={loading}
                    >
                      保存
                    </Button>
                  </SpaceBetween>
                }
              >
                <Container header={<Header variant="h2">一般設定</Header>}>
                  <SpaceBetween size="l">
                    {saveStatus === 'success' && (
                      <Alert
                        type="success"
                        dismissible
                        onDismiss={() => setSaveStatus('idle')}
                      >
                        設定を保存しました
                      </Alert>
                    )}
                    {saveStatus === 'error' && (
                      <Alert
                        type="error"
                        dismissible
                        onDismiss={() => setSaveStatus('idle')}
                      >
                        {saveError}
                      </Alert>
                    )}
                    <FormField
                      label="テナント名"
                      description="組織の表示名を設定します"
                    >
                      <Input
                        value={tenantName}
                        onChange={({ detail }) => setTenantName(detail.value)}
                        placeholder="テナント名を入力"
                        disabled={loading}
                      />
                    </FormField>
                    <FormField
                      label="スラッグ"
                      description="URL に使用される識別子です"
                    >
                      <Input
                        value={slug}
                        onChange={({ detail }) => setSlug(detail.value)}
                        placeholder="tenant-slug"
                        disabled={loading}
                      />
                    </FormField>
                  </SpaceBetween>
                </Container>
              </Form>
            ),
          },
          {
            id: 'api-key',
            label: 'API キー',
            content: (
              <Container header={<Header variant="h2">API キー</Header>}>
                <SpaceBetween size="l">
                  <FormField
                    label="現在の API キー"
                    description="外部連携に使用する API キーです"
                  >
                    <SpaceBetween direction="horizontal" size="xs">
                      <Box variant="code" data-testid="masked-api-key">
                        {loading ? '読み込み中...' : maskApiKey(apiKey)}
                      </Box>
                      <Button
                        iconName="copy"
                        variant="inline-icon"
                        onClick={handleCopyApiKey}
                        ariaLabel="API キーをコピー"
                      />
                    </SpaceBetween>
                  </FormField>
                  {copied && (
                    <StatusIndicator type="success">
                      コピーしました
                    </StatusIndicator>
                  )}
                  <Button
                    onClick={() => setRegenerateModalVisible(true)}
                    variant="normal"
                  >
                    API キーを再生成
                  </Button>
                </SpaceBetween>
              </Container>
            ),
          },
          {
            id: 'danger',
            label: '危険ゾーン',
            content: (
              <Container
                header={
                  <Header variant="h2" description="この操作は取り消せません">
                    危険ゾーン
                  </Header>
                }
              >
                <SpaceBetween size="l">
                  <Box>
                    <SpaceBetween size="s">
                      <Box variant="p">
                        すべてのイベント、参加者、チームデータを完全に削除します。この操作は元に戻すことができません。
                      </Box>
                      <Button
                        variant="link"
                        onClick={() => setDeleteModalVisible(true)}
                        data-testid="delete-all-data-button"
                      >
                        <Box color="text-status-error">全データを削除</Box>
                      </Button>
                    </SpaceBetween>
                  </Box>
                </SpaceBetween>
              </Container>
            ),
          },
        ]}
      />
      <Modal
        visible={regenerateModalVisible}
        onDismiss={() => setRegenerateModalVisible(false)}
        header="API キーの再生成"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="link"
                onClick={() => setRegenerateModalVisible(false)}
              >
                キャンセル
              </Button>
              <Button
                variant="primary"
                onClick={handleRegenerateApiKey}
                loading={regenerating}
              >
                再生成
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Box variant="p">
          現在の API キーは無効になります。この操作を実行してもよろしいですか？
        </Box>
      </Modal>
      <Modal
        visible={deleteModalVisible}
        onDismiss={() => {
          setDeleteModalVisible(false);
          setDeleteConfirmation('');
          setDeleteError('');
        }}
        header="全データの削除"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                variant="link"
                onClick={() => {
                  setDeleteModalVisible(false);
                  setDeleteConfirmation('');
                  setDeleteError('');
                }}
              >
                キャンセル
              </Button>
              <Button
                variant="primary"
                onClick={handleDeleteAllData}
                loading={deleting}
                disabled={deleteConfirmation !== 'DELETE'}
              >
                削除を実行
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {deleteError && <Alert type="error">{deleteError}</Alert>}
          <Box variant="p">
            この操作はすべてのデータを完全に削除します。元に戻すことはできません。
          </Box>
          <FormField label="確認のため「DELETE」と入力してください">
            <Input
              value={deleteConfirmation}
              onChange={({ detail }) => setDeleteConfirmation(detail.value)}
              placeholder="DELETE"
            />
          </FormField>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
}
