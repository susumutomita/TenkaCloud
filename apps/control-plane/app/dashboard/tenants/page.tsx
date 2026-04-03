/**
 * Tenants Page
 *
 * Cloudscape Design System — Container + ColumnLayout + TenantList
 */

import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import '@cloudscape-design/global-styles/index.css';
import Link from 'next/link';
import { TenantList } from '@/components/tenants/tenant-list';
import { tenantApi } from '@/lib/api/tenant-api';

export const dynamic = 'force-dynamic';
export const fetchCache = 'default-no-store';

export default async function TenantsPage() {
  const tenants = await tenantApi.listTenants();

  const total = tenants.length;
  const activeCount = tenants.filter((t) => t.status === 'ACTIVE').length;
  const suspendedCount = tenants.filter((t) => t.status === 'SUSPENDED').length;
  const enterpriseCount = tenants.filter((t) => t.tier === 'ENTERPRISE').length;

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="テナントの作成・管理を行います。"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Link href="/dashboard/tenants/new">
              <Button variant="primary">新規テナントを作成</Button>
            </Link>
            <a
              href="https://github.com/susumutomita/TenkaCloud/blob/main/docs/architecture/tenant-management-integration.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button>設計ドキュメント</Button>
            </a>
          </SpaceBetween>
        }
      >
        <Box variant="small" color="text-body-secondary">
          Control Plane
        </Box>
        テナント管理
      </Header>

      <ColumnLayout columns={4} variant="text-grid">
        {[
          { label: '総テナント', value: total },
          { label: '稼働中', value: activeCount },
          { label: '一時停止', value: suspendedCount },
          { label: 'Enterprise', value: enterpriseCount },
        ].map((item) => (
          <Container key={item.label}>
            <Box variant="awsui-key-label">{item.label}</Box>
            <Box variant="awsui-value-large">{item.value}</Box>
          </Container>
        ))}
      </ColumnLayout>

      <Container
        header={
          <Header
            variant="h2"
            description="テナントの検索・フィルタリングができます"
          >
            テナント一覧
          </Header>
        }
      >
        <TenantList tenants={tenants} />
      </Container>
    </SpaceBetween>
  );
}
