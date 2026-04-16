/**
 * Admin Attack Catalog Page
 *
 * Cloudscape Design System - GameDay イベントの攻撃カタログ管理
 */

'use client';

import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import '@cloudscape-design/global-styles/index.css';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { getAttackCatalog } from '@/lib/api/gameday';
import { seedAttacks } from '@/lib/api/gameday-admin';
import type { Attack } from '@/lib/api/gameday-types';

export default function AdminAttackCatalogPage() {
  const router = useRouter();
  const params = useParams();
  const eventId = params.eventId as string;

  const [attacks, setAttacks] = useState<Attack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  const fetchAttacks = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getAttackCatalog(eventId);
      setAttacks(data.attacks);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : '\u653b\u6483\u30ab\u30bf\u30ed\u30b0\u306e\u53d6\u5f97\u306b\u5931\u6557\u3057\u307e\u3057\u305f',
      );
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    fetchAttacks();
  }, [fetchAttacks]);

  const handleSeed = async () => {
    setSeeding(true);
    try {
      await seedAttacks(eventId);
      await fetchAttacks();
    } catch {
      // Error handled by re-fetch
    } finally {
      setSeeding(false);
    }
  };

  if (loading) {
    return (
      <Box textAlign="center" padding="xl">
        <Spinner size="large" />
      </Box>
    );
  }

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={`\u30a4\u30d9\u30f3\u30c8 ID: ${eventId}`}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="primary" loading={seeding} onClick={handleSeed}>
              {attacks.length > 0
                ? '\u30ab\u30bf\u30ed\u30b0\u3092\u518d\u751f\u6210'
                : '\u30c7\u30d5\u30a9\u30eb\u30c8\u653b\u6483\u3092\u30b7\u30fc\u30c9'}
            </Button>
            <Button onClick={() => router.push(`/admin/events/${eventId}`)}>
              {'\u30a4\u30d9\u30f3\u30c8\u306b\u623b\u308b'}
            </Button>
          </SpaceBetween>
        }
      >
        {'\u653b\u6483\u30ab\u30bf\u30ed\u30b0\u7ba1\u7406'}
      </Header>

      {/* Stats */}
      <Container>
        <SpaceBetween direction="horizontal" size="xl">
          <div>
            <Box variant="awsui-key-label">{'\u7dcf\u653b\u6483\u6570'}</Box>
            <Box variant="awsui-value-large">{attacks.length}</Box>
          </div>
          <div>
            <Box variant="awsui-key-label">
              {'\u5e73\u5747\u30b3\u30b9\u30c8'}
            </Box>
            <Box variant="awsui-value-large">
              {attacks.length > 0
                ? Math.round(
                    attacks.reduce((sum, a) => sum + a.purchaseCost, 0) /
                      attacks.length,
                  ).toLocaleString()
                : 0}
            </Box>
          </div>
          <div>
            <Box variant="awsui-key-label">
              {'\u5e73\u5747\u30c0\u30e1\u30fc\u30b8'}
            </Box>
            <Box variant="awsui-value-large">
              {attacks.length > 0
                ? Math.round(
                    attacks.reduce((sum, a) => sum + a.damage, 0) /
                      attacks.length,
                  ).toLocaleString()
                : 0}
            </Box>
          </div>
        </SpaceBetween>
      </Container>

      {error && (
        <Container>
          <SpaceBetween size="m" direction="vertical" alignItems="center">
            <StatusIndicator type="error">{error}</StatusIndicator>
            <Button onClick={fetchAttacks}>
              {'\u518d\u8aad\u307f\u8fbc\u307f'}
            </Button>
          </SpaceBetween>
        </Container>
      )}

      {!error && (
        <Table
          items={attacks}
          header={
            <Header counter={`(${attacks.length})`}>
              {'\u653b\u6483\u4e00\u89a7'}
            </Header>
          }
          empty={
            <Box textAlign="center" padding="l">
              <SpaceBetween size="m">
                <Box variant="h3">
                  {
                    '\u653b\u6483\u30ab\u30bf\u30ed\u30b0\u304c\u7a7a\u3067\u3059'
                  }
                </Box>
                <Box color="text-body-secondary">
                  {
                    '\u30c7\u30d5\u30a9\u30eb\u30c8\u653b\u6483\u3092\u30b7\u30fc\u30c9\u3057\u3066\u30ab\u30bf\u30ed\u30b0\u3092\u521d\u671f\u5316\u3057\u307e\u3057\u3087\u3046\u3002'
                  }
                </Box>
                <Button
                  variant="primary"
                  loading={seeding}
                  onClick={handleSeed}
                >
                  {
                    '\u30c7\u30d5\u30a9\u30eb\u30c8\u653b\u6483\u3092\u30b7\u30fc\u30c9'
                  }
                </Button>
              </SpaceBetween>
            </Box>
          }
          columnDefinitions={[
            {
              id: 'name',
              header: '\u653b\u6483\u540d',
              cell: (item) => <Box fontWeight="bold">{item.name}</Box>,
              sortingField: 'name',
            },
            {
              id: 'type',
              header: '\u30bf\u30a4\u30d7',
              cell: (item) =>
                item.attackType === 'vulnerability' ? (
                  <Badge color="red">{'\u8106\u5f31\u6027'}</Badge>
                ) : (
                  <Badge color="blue">{'\u30ab\u30aa\u30b9'}</Badge>
                ),
            },
            {
              id: 'cost',
              header: '\u30b3\u30b9\u30c8',
              cell: (item) => `${item.purchaseCost.toLocaleString()} pts`,
              sortingField: 'purchaseCost',
            },
            {
              id: 'damage',
              header: '\u30c0\u30e1\u30fc\u30b8',
              cell: (item) => `${item.damage.toLocaleString()} pts`,
              sortingField: 'damage',
            },
            {
              id: 'reward',
              header: '\u5831\u916c',
              cell: (item) => `${item.reward.toLocaleString()} pts`,
              sortingField: 'reward',
            },
            {
              id: 'cooldown',
              header: '\u30af\u30fc\u30eb\u30c0\u30a6\u30f3',
              cell: (item) => `${item.cooldownSeconds}s`,
            },
            {
              id: 'hintCost',
              header: '\u30d2\u30f3\u30c8\u30b3\u30b9\u30c8',
              cell: (item) => `${item.hintCost.toLocaleString()} pts`,
            },
          ]}
        />
      )}
    </SpaceBetween>
  );
}
