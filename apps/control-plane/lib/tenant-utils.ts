import { tenantApi } from '@/lib/api/tenant-api';
import type { Tenant, TenantTier } from '@/types/tenant';

/** ステータスに応じた Badge variant を返す */
export const getStatusVariant = (status: string) => {
  if (status === 'ACTIVE') return 'success';
  if (status === 'SUSPENDED') return 'warning';
  return 'error';
};

/** テナント更新フォームデータの型 */
export type TenantFormData = {
  name: string;
  adminEmail: string;
  tier: TenantTier;
  status: Tenant['status'];
};

/** テナント更新処理 */
export async function submitTenantUpdate(
  id: string | null,
  formData: TenantFormData,
  onSuccess: () => void,
  onError: () => void
): Promise<boolean> {
  if (!id) {
    return false;
  }

  try {
    await tenantApi.updateTenant(id, formData);
    onSuccess();
    return true;
  } catch (error) {
    console.error('Failed to update tenant:', error);
    onError();
    return false;
  }
}
