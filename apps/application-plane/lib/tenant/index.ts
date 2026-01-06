/**
 * テナントモジュール
 *
 * Application Plane でマルチテナントを扱うためのユーティリティ
 */

export {
  getTenantSlugFromUrl,
  getTenantSlugFromSubdomain,
  getTenantSlugFromQueryParam,
  buildApplicationPlaneUrl,
  isValidTenantSlug,
} from './identification';

export {
  TenantProvider,
  useTenant,
  useTenantOptional,
  type TenantInfo,
  type UserRole,
} from './context';
