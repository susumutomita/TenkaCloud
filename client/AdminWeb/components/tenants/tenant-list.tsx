'use client';

import Box from '@cloudscape-design/components/box';
import CloudButton from '@cloudscape-design/components/button';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { tenantApi } from '@/lib/api/tenant-api';
import { getStatusVariant } from '@/lib/tenant-utils';
import type { Tenant, TenantStatus, TenantTier } from '@/types/tenant';
import { TENANT_STATUS_LABELS, TENANT_TIER_LABELS } from '@/types/tenant';

interface TenantListProps {
  tenants: Tenant[];
}

export function TenantList({ tenants }: TenantListProps) {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TenantStatus | 'ALL'>('ALL');
  const [tierFilter, setTierFilter] = useState<TenantTier | 'ALL'>('ALL');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Tenant | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete(id: string) {
    setDeletingId(id);
    setDeleteError(null);
    try {
      const success = await tenantApi.deleteTenant(id);
      if (success) {
        router.refresh();
      } else {
        setDeleteError('テナントの削除に失敗しました。対象が見つかりません。');
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'テナントの削除中にエラーが発生しました。';
      setDeleteError(message);
    } finally {
      setDeletingId(null);
      setDeleteTarget(null);
    }
  }

  const filteredTenants = tenants.filter((tenant) => {
    const matchesSearch =
      searchQuery === '' ||
      tenant.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tenant.adminEmail.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tenant.id.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus =
      statusFilter === 'ALL' || tenant.status === statusFilter;

    const matchesTier = tierFilter === 'ALL' || tenant.tier === tierFilter;

    return matchesSearch && matchesStatus && matchesTier;
  });

  return (
    <div className="space-y-4">
      {/* Search and Filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="テナント名、メール、IDで検索..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex h-10 w-full rounded-md border border-border bg-background py-2 pl-10 pr-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="flex gap-2">
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as TenantStatus | 'ALL')
            }
            className="flex h-10 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="ALL">すべてのステータス</option>
            {Object.entries(TENANT_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={tierFilter}
            onChange={(e) =>
              setTierFilter(e.target.value as TenantTier | 'ALL')
            }
            className="flex h-10 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="ALL">すべてのTier</option>
            {Object.entries(TENANT_TIER_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Results Count */}
      <div className="text-sm text-muted-foreground">
        {filteredTenants.length === tenants.length
          ? `${tenants.length} 件のテナント`
          : `${filteredTenants.length} / ${tenants.length} 件を表示`}
      </div>

      {/* Table */}
      {filteredTenants.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            {tenants.length === 0
              ? 'テナントがまだ登録されていません'
              : '検索条件に一致するテナントがありません'}
          </p>
          {tenants.length === 0 ? (
            <Link href="/dashboard/tenants/new">
              <Button variant="outline" className="mt-4">
                最初のテナントを作成
              </Button>
            </Link>
          ) : (
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => {
                setSearchQuery('');
                setStatusFilter('ALL');
                setTierFilter('ALL');
              }}
            >
              フィルターをクリア
            </Button>
          )}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>テナント</TableHead>
              <TableHead>ステータス</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>管理者 Email</TableHead>
              <TableHead>作成日</TableHead>
              <TableHead className="text-right">アクション</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredTenants.map((tenant) => (
              <TableRow key={tenant.id}>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <Link
                      href={`/dashboard/tenants/detail?id=${encodeURIComponent(tenant.id)}`}
                      className="font-semibold hover:underline"
                    >
                      {tenant.name}
                    </Link>
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">
                      ID: {tenant.id}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={getStatusVariant(tenant.status)}>
                    {TENANT_STATUS_LABELS[tenant.status]}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="capitalize">
                    {TENANT_TIER_LABELS[tenant.tier]}
                  </Badge>
                </TableCell>
                <TableCell>{tenant.adminEmail}</TableCell>
                <TableCell>
                  {new Date(tenant.createdAt).toLocaleDateString('ja-JP')}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-2">
                    <Link
                      href={`/dashboard/tenants/detail?id=${encodeURIComponent(tenant.id)}`}
                    >
                      <Button variant="ghost" size="sm">
                        詳細
                      </Button>
                    </Link>
                    <Link
                      href={`/dashboard/tenants/edit?id=${encodeURIComponent(tenant.id)}`}
                    >
                      <Button variant="ghost" size="sm">
                        編集
                      </Button>
                    </Link>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteTarget(tenant);
                      }}
                    >
                      削除
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {deleteError && (
        <div
          className="rounded-md border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-800 dark:text-rose-300"
          role="alert"
        >
          {deleteError}
        </div>
      )}

      <Modal
        visible={deleteTarget !== null}
        onDismiss={() => setDeleteTarget(null)}
        header="テナントを削除しますか？"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <CloudButton variant="link" onClick={() => setDeleteTarget(null)}>
                キャンセル
              </CloudButton>
              <CloudButton
                variant="primary"
                onClick={() => {
                  handleDelete(deleteTarget!.id);
                }}
                loading={deletingId !== null}
              >
                削除する
              </CloudButton>
            </SpaceBetween>
          </Box>
        }
      >
        「{deleteTarget?.name}」を削除します。この操作は取り消せません。
      </Modal>
    </div>
  );
}
