import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const participantUrl =
  process.env.NEXT_PUBLIC_PARTICIPANT_URL || 'http://localhost:3002';
const controlPlaneUrl =
  process.env.NEXT_PUBLIC_CONTROL_PLANE_URL || 'http://localhost:3000';

const highlight = [
  { label: '稼働率 (過去 24h)', value: '99.95%' },
  { label: '未処理の申請', value: '3 件' },
  { label: '今週のデプロイ', value: '5 回' },
];

export default function Home() {
  return (
    <div className="min-h-screen bg-background p-8">
      <main className="mx-auto max-w-7xl space-y-8">
        {/* Header */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                Admin Console
              </p>
              <h1 className="text-3xl font-bold tracking-tight">
                TenkaCloud Admin Dashboard
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                テナント管理者向けの運用ダッシュボードです。認証は Keycloak
                で保護され、実データはバックエンド接続後に読み込まれます。
              </p>
            </div>
            <div className="flex gap-3">
              <Link href="/docs/architecture">
                <Button variant="outline">アーキテクチャ</Button>
              </Link>
              <a href={controlPlaneUrl}>
                <Button>Control Plane を開く</Button>
              </a>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-6 md:grid-cols-3">
          {highlight.map((item) => (
            <Card key={item.label}>
              <CardHeader className="pb-2">
                <CardDescription className="text-xs uppercase tracking-wide">
                  {item.label}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{item.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Main Content */}
        <div className="grid gap-6 md:grid-cols-3">
          {/* Operations Checklist */}
          <Card className="md:col-span-2">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>運用チェックリスト</CardTitle>
                  <CardDescription>
                    日常的な運用タスクの確認事項
                  </CardDescription>
                </div>
                <Badge variant="success">安定稼働中</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <ul className="space-y-4">
                <li className="flex items-start gap-3">
                  <div className="mt-1 h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="text-sm">
                    Keycloak Realm
                    とクライアント設定を確認し、管理者ロールが最新であることをチェック。
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <div className="mt-1 h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="text-sm">
                    バトル用の問題セットが最新リリースと一致しているか検証し、プレビューでレンダリングを確認。
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <div className="mt-1 h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="text-sm">
                    監査ログの転送先 (OpenSearch / CloudWatch 相当)
                    が到達可能であることを確認。
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <div className="mt-1 h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="text-sm">
                    重大インシデントのエスカレーション先 (Slack / PagerDuty)
                    が有効か定期テストを実施。
                  </span>
                </li>
              </ul>
            </CardContent>
          </Card>

          {/* Links */}
          <Card>
            <CardHeader>
              <CardTitle>接続先</CardTitle>
              <CardDescription>
                実環境の URL を設定すると各アプリへ直接遷移できます。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <a href={participantUrl}>
                <Button className="w-full">Participant UI を開く</Button>
              </a>
              <a href={controlPlaneUrl}>
                <Button variant="outline" className="w-full">
                  Control Plane UI を開く
                </Button>
              </a>
              <Link href="/frontend/participant-app/README.md">
                <Button variant="ghost" className="w-full">
                  セットアップ手順を読む
                </Button>
              </Link>
              <div className="mt-4 rounded-lg border border-amber-300/30 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs text-amber-900 dark:text-amber-100">
                NEXT_PUBLIC_PARTICIPANT_URL と NEXT_PUBLIC_CONTROL_PLANE_URL
                を設定すると、実環境にリンクされます。
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
