'use client';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { tenantApi } from '@/lib/api/tenant-api';
interface TenantActionsProps { tenantId: string; }
export function TenantActions({ tenantId }: TenantActionsProps) {
  const router = useRouter(); const [isDeleting, setIsDeleting] = useState(false); const [open, setOpen] = useState(false);
  const handleDelete = async () => { setIsDeleting(true); try { await tenantApi.deleteTenant(tenantId); setOpen(false); router.push('/dashboard/tenants'); router.refresh(); } catch (error) { console.error('Failed to delete tenant:', error); alert('テナント削除に失敗しました'); } finally { setIsDeleting(false); } };
  return (<><Button variant="normal" onClick={() => setOpen(true)}>削除</Button><Modal visible={open} onDismiss={() => setOpen(false)} header="テナントを削除しますか？" footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs"><Button variant="link" onClick={() => setOpen(false)} disabled={isDeleting}>キャンセル</Button><Button variant="primary" onClick={handleDelete} loading={isDeleting} disabled={isDeleting}>{isDeleting ? '削除中...' : '削除する'}</Button></SpaceBetween></Box>}><Box>この操作は取り消せません。テナントに関連するすべてのデータが完全に削除されます。</Box></Modal></>);
}
