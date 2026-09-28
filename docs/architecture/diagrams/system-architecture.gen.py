"""system-architecture.drawio の 5 ページを生成する。

ファイルの外枠（<mxfile> と各 <diagram> の id・名前）は残し、5 ページの中身を毎回まるごと作り直す。
01 SaaS・02 Lite の境界（AWS Cloud、Region、各スタック、External trust boundaries、競技用アカウント）の枠は
元の図と同じ書式にし、中身は aws-drawio-diagram Skill の描き方（公式アイコン、ラベルはアイコンの下、直角の線）に合わせる。
03〜05 も同じ描き方にそろえる。内容はすべてコードで確かめたものだけを書く。
座標はすべて絶対座標で書き、親の枠からの相対座標へ変換する。
"""

import re
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).parent
SRC = OUT = HERE / "system-architecture.drawio"

ICON = 60
HALF = ICON // 2

YU = 60
R0, R1, R2, R3, R4, R5, R6 = 460, 620, 790, 1010, 1180, 1350, 1520
# リージョンの上の帯を通る線の高さ。遠くへ行く線ほど上にする。
BAND_A, BAND_B, BAND_D, BAND_E, BAND_C = 190, 214, 238, 262, 286

COLOR = {
    "cloudfront": "#8C4FFF",
    "api_gateway": "#8C4FFF",
    "s3": "#7AA116",
    "budgets": "#7AA116",
    "cognito": "#DD344C",
    "identity_and_access_management": "#DD344C",
    "lambda": "#ED7100",
    "dynamodb": "#C925D1",
    "codebuild": "#C925D1",
    "codepipeline": "#C925D1",
    "eventbridge": "#E7157B",
    "step_functions": "#E7157B",
    "cloudformation": "#E7157B",
    "systems_manager": "#E7157B",
    "cloudwatch_2": "#E7157B",
    "general": "#232F3E",
    "user": "#242F3E",
    "users": "#242F3E",
    "corporate_data_center": "#242F3E",
    "traditional_server": "#242F3E",
    "client": "#242F3E",
    "container_1": "#242F3E",
    "container_2": "#242F3E",
    "document": "#242F3E",
    "documents": "#242F3E",
    "disk": "#242F3E",
    "gear": "#242F3E",
    "generic_database": "#242F3E",
    "email": "#242F3E",
    "internet": "#242F3E",
}
STANDALONE = {"user", "users", "corporate_data_center", "traditional_server", "client", "container_1", "container_2", "document", "documents", "disk", "gear", "generic_database", "email", "internet"}

# 元の図の枠の書式。位置と大きさだけを変える。
SWIMLANE = "swimlane;horizontal=1;startSize=40;rounded=0;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};strokeWidth=2;dashed={dashed};fontSize={size};fontStyle=1;fontColor={stroke};align=left;spacingLeft=14;collapsible=0"


def lane(fill, stroke, size=15, dashed=0):
    return SWIMLANE.format(fill=fill, stroke=stroke, size=size, dashed=dashed)


CLOUD = lane("#FFFFFF", "#232F3E", 16)
REGION = lane("#FFFFFF", "#147EBA", 17, 1)
EXTERNAL = lane("#FBF9FF", "#7652B6", 16)
CONSOLE_STACK = lane("#FAFBFC", "#405A78")
LIFECYCLE_STACK = lane("#F7FAFD", "#147EBA")
PLATFORM_STACK = lane("#F8FAFC", "#64748B")
TENANT_STACK = lane("#F7FCF9", "#2E7B50")
BACKEND_STACK = lane("#FFF9F7", "#B54736")
OPTIONAL_STACK = lane("#FFFDF8", "#B7791F", 15, 1)

MAIN = "edgeStyle=orthogonalEdgeStyle;html=1;endArrow=block;endFill=1;strokeColor=#545B64;rounded=0;labelBackgroundColor=none;verticalAlign=bottom;"
AUX = "edgeStyle=orthogonalEdgeStyle;html=1;endArrow=block;endFill=1;strokeColor=#E7157B;rounded=0;dashed=1;labelBackgroundColor=none;verticalAlign=bottom;"


def attr(s):
    return escape(s, {'"': "&quot;", "\n": "&#xa;"})


class Diagram:
    """frames: (id, parent, label, style, left, right, top[, min_bottom])、
    icons: (id, parent, shape, label, x, y)（60x60、ラベルは下）、boxes: (id, parent, label, x, y, w, h, style)（ラベルは中）。"""

    def __init__(self, frames, icons, boxes=(), align_bottoms=()):
        self.frames = [f + (None,) * (8 - len(f)) for f in frames]
        self.icons = icons
        self.boxes = boxes
        self.edges = []
        self.geo = {i[0]: (i[4], i[5], ICON, ICON, "icon") for i in icons}
        self.geo.update({b[0]: (b[3], b[4], b[5], b[6], "box") for b in boxes})
        self.lines = {i[0]: i[3].count("\n") + 1 for i in icons}
        self.parent = {i[0]: i[1] for i in icons}
        self.parent.update({b[0]: b[1] for b in boxes})
        self.parent.update({f[0]: f[1] for f in self.frames})
        self.rect = {}
        for fid, _parent, _label, _style, left, right, top, min_bottom in reversed(self.frames):
            bottoms = [y + HALF + 16 * self.lines[i] + 24 for i, p, _s, _l, _x, y in icons if p == fid]
            bottoms += [b[4] + b[6] / 2 + 24 for b in boxes if b[1] == fid]
            bottoms += [self.rect[f[0]][3] + 20 for f in self.frames if f[1] == fid]
            if min_bottom:
                bottoms.append(min_bottom)
            self.rect[fid] = [left, top, right, max(bottoms)]
        if align_bottoms:
            bottom = max(self.rect[f][3] for f in align_bottoms)
            for f in align_bottoms:
                self.rect[f][3] = bottom

    def edge(self, src, ex, dst, en, label, aux=False, via=None, pos=0, lab=None, straight=False, arrow=True):
        """lab=(k, f) を渡すと、k 番目の区間の f の位置にラベルを置く（pos を計算で決める）。"""
        self.edges.append((src, ex, dst, en, label, aux, via or [], pos, lab, straight, arrow))

    def dy(self, cid):
        return {1: 24, 2: 38, 3: 52}[self.lines[cid]]

    def port(self, cid, side, at=0.5, entry=False):
        """(style 断片, 絶対座標)。アイコンの下の辺はラベルの下までずらし、矢印の先は文字に触れないよう少し離す。
        枠につなぐときは at を絶対座標（上下の辺は x、左右の辺は y）で受け取る。"""
        if cid in self.rect:
            x0, y0, x1, y1 = self.rect[cid]
            if side in ("top", "bottom"):
                fy = 0 if side == "top" else 1
                return f"X={(at - x0) / (x1 - x0):.4f};{{k}}Y={fy};{{k}}Perimeter=0;", (at, y0 if fy == 0 else y1)
            fx = 0 if side == "left" else 1
            return f"X={fx};{{k}}Y={(at - y0) / (y1 - y0):.4f};{{k}}Perimeter=0;", (x0 if fx == 0 else x1, at)
        cx, cy, w, h, kind = self.geo[cid]
        if side == "top":
            return f"X={at};{{k}}Y=0;", (cx - w / 2 + w * at, cy - h / 2)
        if side == "left":
            return f"X=0;{{k}}Y={at};", (cx - w / 2, cy - h / 2 + h * at)
        if side == "right":
            return f"X=1;{{k}}Y={at};", (cx + w / 2, cy - h / 2 + h * at)
        if kind == "box":
            return f"X={at};{{k}}Y=1;", (cx - w / 2 + w * at, cy + h / 2)
        dy = self.dy(cid) + (4 if entry else 0)
        return f"X={at};{{k}}Y=1;{{k}}Dy={dy};{{k}}Perimeter=0;", (cx - w / 2 + w * at, cy + h / 2 + dy)

    def origin(self, cid):
        p = self.parent[cid]
        return (0, 0) if p == "1" else (self.rect[p][0], self.rect[p][1])

    def model(self):
        cells = ['<mxCell id="0" />', '<mxCell id="1" parent="0" />']
        for fid, parent, label, style, *_ in self.frames:
            x0, y0, x1, y1 = self.rect[fid]
            ox, oy = self.origin(fid)
            cells.append(
                f'<mxCell id="{fid}" value="{attr(label)}" style="{style}" vertex="1" parent="{parent}">'
                f'<mxGeometry x="{x0 - ox:g}" y="{y0 - oy:g}" width="{x1 - x0:g}" height="{y1 - y0:g}" as="geometry" /></mxCell>'
            )
        for iid, parent, shape, label, cx, cy in self.icons:
            color = COLOR[shape]
            if shape in STANDALONE:
                style = f"fontColor=#16191F;fillColor={color};strokeColor=none;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;aspect=fixed;shape=mxgraph.aws4.{shape}"
            else:
                style = f"fontColor=#16191F;fillColor={color};strokeColor=#ffffff;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.{shape}"
            ox, oy = self.origin(iid)
            cells.append(
                f'<mxCell id="{iid}" value="{attr(label)}" style="{style}" vertex="1" parent="{parent}">'
                f'<mxGeometry x="{cx - HALF - ox:g}" y="{cy - HALF - oy:g}" width="{ICON}" height="{ICON}" as="geometry" /></mxCell>'
            )
        for bid, parent, label, cx, cy, w, h, style in self.boxes:
            ox, oy = self.origin(bid)
            cells.append(
                f'<mxCell id="{bid}" value="{attr(label)}" style="{style}" vertex="1" parent="{parent}">'
                f'<mxGeometry x="{cx - w / 2 - ox:g}" y="{cy - h / 2 - oy:g}" width="{w:g}" height="{h:g}" as="geometry" /></mxCell>'
            )
        for src, ex, dst, en, label, aux, via, pos, lab, straight, arrow in self.edges:
            ex_style, ex_pt = self.port(src, *ex)
            en_style, en_pt = self.port(dst, *en, entry=True)
            points = [ex_pt, *via, en_pt]
            if lab:
                pos = lab_pos(points, *lab)
            style = AUX if aux else MAIN
            if straight:
                style = style.replace("edgeStyle=orthogonalEdgeStyle;", "edgeStyle=none;") + "align=center;"
            else:
                style += "align=center;" if label_orient(points, pos) == "h" else "align=left;spacingLeft=6;"
            if not arrow:
                style = style.replace("endArrow=block;endFill=1;", "endArrow=none;")
            style += "exit" + ex_style.format(k="exit") + "entry" + en_style.format(k="entry")
            pts = "".join(f'<mxPoint x="{px:g}" y="{py:g}" />' for px, py in via)
            inner = f'<Array as="points">{pts}</Array>' if via else ""
            geo_x = f' x="{pos}"' if pos else ""
            cells.append(
                f'<mxCell id="edge-{src}-to-{dst}" value="{attr(label)}" style="{style}" edge="1" parent="1" source="{src}" target="{dst}">'
                f'<mxGeometry{geo_x} relative="1" as="geometry">{inner}</mxGeometry></mxCell>'
            )
        ids = [re.search(r'id="([^"]+)"', c).group(1) for c in cells]
        assert len(ids) == len(set(ids)), "id が重複している"
        body = "\n                ".join(cells)
        width = max(r[2] for r in self.rect.values()) + 200
        height = max(r[3] for r in self.rect.values()) + 100
        return (
            f'<mxGraphModel adaptiveColors="auto" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="0" page="1" pageScale="1" pageWidth="{width:g}" pageHeight="{height:g}" math="0" shadow="0">\n'
            f"            <root>\n                {body}\n            </root>\n        </mxGraphModel>"
        )


def lab_pos(points, k, f):
    lens = [abs(a[0] - b[0]) + abs(a[1] - b[1]) for a, b in zip(points, points[1:])]
    return round(2 * (sum(lens[:k]) + lens[k] * f) / sum(lens) - 1, 4)


def label_orient(points, pos):
    segs = list(zip(points, points[1:]))
    lens = [abs(a[0] - b[0]) + abs(a[1] - b[1]) for a, b in segs]
    target = sum(lens) * (pos + 1) / 2
    for (a, b), n in zip(segs, lens):
        if target <= n:
            return "h" if a[1] == b[1] else "v"
        target -= n
    a, b = segs[-1]
    return "h" if a[1] == b[1] else "v"


def saas():
    frames = [
        ("aws-tenkacloud", "1", "AWS Cloud", CLOUD, 20, 4430, 130),
        ("region-tenkacloud", "aws-tenkacloud", "AWS Region — account / environment boundary", REGION, 40, 4410, 300, 1720),
        ("stack-runtime-config", "region-tenkacloud", "AdminConsoleRuntimeConfigStack", CONSOLE_STACK, 60, 350, 360),
        ("stack-admin-hosting", "region-tenkacloud", "AdminConsoleHostingStack", CONSOLE_STACK, 375, 745, 360),
        ("stack-control-plane", "region-tenkacloud", "ControlPlaneStack（SBT）", CONSOLE_STACK, 760, 1400, 360),
        ("stack-bootstrap", "region-tenkacloud", "BootstrapTemplateStack", LIFECYCLE_STACK, 760, 1400, 910),
        ("stack-insight", "region-tenkacloud", "AdminConsoleInsightStack", CONSOLE_STACK, 1430, 1850, 360),
        ("stack-observability", "region-tenkacloud", "ObservabilityStack", PLATFORM_STACK, 1430, 1850, 910),
        ("stack-pipeline", "region-tenkacloud", "ServerlessSaaSPipeline", PLATFORM_STACK, 1650, 2320, 1250),
        ("stack-tenant-template", "region-tenkacloud", "TenantTemplateStack（pooled・silo）", TENANT_STACK, 1880, 2760, 360),
        ("stack-problem-deploy", "region-tenkacloud", "ProblemDeployBackendStack", BACKEND_STACK, 2790, 3990, 360),
        ("stack-challenge-payload", "region-tenkacloud", "ChallengePayloadStack（任意）", OPTIONAL_STACK, 4020, 4390, 360),
        ("external", "1", "External trust boundaries", EXTERNAL, 4530, 5130, 130),
        ("competitor-account", "external", "Competitor AWS account", BACKEND_STACK, 4570, 5090, 1080),
    ]
    icons = [
        ("user-system-admin", "1", "user", "システム管理者", 1090, YU),
        ("user-operator", "1", "user", "運用担当者", 1865, YU),
        ("user-organizer", "1", "user", "開催者", 2450, YU),
        ("user-participants", "1", "users", "参加者", 3500, YU),
        ("user-author", "1", "user", "問題作成者", 5300, YU),
        ("lambda-runtime-config", "stack-runtime-config", "lambda", "AWS Lambda\nBucketDeployment", 250, R0),
        ("cloudfront-admin", "stack-admin-hosting", "cloudfront", "Amazon CloudFront\nシステム管理コンソール", 630, R0),
        ("s3-admin", "stack-admin-hosting", "s3", "Amazon S3\n管理コンソール", 630, R1),
        ("apigw-control-plane", "stack-control-plane", "api_gateway", "Amazon API Gateway\nコントロールプレーン API", 1090, R1),
        ("cognito-system-admin", "stack-control-plane", "cognito", "Amazon Cognito\nシステム管理者（MFA・SAML 任意）", 1310, R1),
        ("dynamodb-tenant-details", "stack-control-plane", "dynamodb", "Amazon DynamoDB\nテナント情報・登録・SAML IdP", 870, R2),
        ("lambda-sbt", "stack-control-plane", "lambda", "AWS Lambda\nテナント・IdP の管理", 1090, R2),
        ("eventbridge-sbt", "stack-control-plane", "eventbridge", "Amazon EventBridge\nSBT のイベントバス", 1310, R2),
        ("sfn-lifecycle", "stack-bootstrap", "step_functions", "AWS Step Functions\nテナントの配置・撤去", 1090, R3),
        ("eventbridge-bootstrap", "stack-bootstrap", "eventbridge", "Amazon EventBridge\nSBT バスのルール", 1310, R3),
        ("dynamodb-tenant-mapping", "stack-bootstrap", "dynamodb", "Amazon DynamoDB\nテナントとスタックの対応表", 870, R4),
        ("codebuild-lifecycle", "stack-bootstrap", "codebuild", "AWS CodeBuild\nテナント配置スクリプト", 1090, R4),
        ("lambda-reconciler", "stack-bootstrap", "lambda", "AWS Lambda\n状態の突き合わせ", 870, R5),
        ("ssm-tier-api-keys", "stack-bootstrap", "systems_manager", "AWS Systems Manager\n階層別 API キーの ID（4 種）", 1090, R5),
        ("lambda-sign-in-audit", "stack-insight", "lambda", "AWS Lambda\nサインイン監査（CloudTrail）", 1540, R1),
        ("apigw-insight", "stack-insight", "api_gateway", "Amazon API Gateway\n閲覧・復旧 API", 1760, R1),
        ("lambda-insight", "stack-insight", "lambda", "AWS Lambda\n閲覧・復旧", 1760, R2),
        ("budgets", "stack-observability", "budgets", "AWS Budgets\n費用の通知（任意）", 1540, R3),
        ("cloudwatch-dashboard", "stack-observability", "cloudwatch_2", "Amazon CloudWatch\nダッシュボード", 1760, R3),
        ("s3-source", "region-tenkacloud", "s3", "Amazon S3\nソースバケット（stack の外で作成）", 1540, R5),
        ("codepipeline", "stack-pipeline", "codepipeline", "AWS CodePipeline\nプラットフォーム更新", 1760, R5),
        ("lambda-prep-deploy", "stack-pipeline", "lambda", "AWS Lambda\n配置の準備", 1760, R6),
        ("sfn-wave", "stack-pipeline", "step_functions", "AWS Step Functions\nウェーブ単位の更新", 2000, R5),
        ("codebuild-update-tenant", "stack-pipeline", "codebuild", "AWS CodeBuild\nテナントの更新", 2230, R5),
        ("lambda-tenant-mapping", "stack-tenant-template", "lambda", "AWS Lambda\n対応表の登録（カスタムリソース）", 1990, R1),
        ("cloudfront-organizer", "stack-tenant-template", "cloudfront", "Amazon CloudFront\n開催管理コンソール", 2230, R0),
        ("s3-organizer", "stack-tenant-template", "s3", "Amazon S3\n開催管理コンソール", 2230, R1),
        ("apigw-tenant", "stack-tenant-template", "api_gateway", "Amazon API Gateway\nテナント REST API", 2450, R1),
        ("cognito-tenant", "stack-tenant-template", "cognito", "Amazon Cognito\n開催者（MFA・silo は SAML 任意）", 2670, R1),
        ("cloudfront-portal", "stack-problem-deploy", "cloudfront", "Amazon CloudFront\n参加者ポータル", 3300, R0),
        ("s3-portal", "stack-problem-deploy", "s3", "Amazon S3\n参加者ポータル", 3300, R1),
        ("lambda-portal", "stack-problem-deploy", "lambda", "AWS Lambda\n参加者 API（関数 URL）", 3500, R1),
        ("lambda-coordination", "stack-problem-deploy", "lambda", "AWS Lambda\n独自競技の中継（関数 URL）", 3700, R1),
        ("s3-coordination", "stack-problem-deploy", "s3", "Amazon S3\n独自競技のプラグイン", 3900, R1),
        ("lambda-api", "stack-problem-deploy", "lambda", "AWS Lambda\n配置・大会・アカウント API", 3100, R2),
        ("dynamodb-control", "stack-problem-deploy", "dynamodb", "Amazon DynamoDB\n制御データ（大会・チーム・配置・監査）", 3500, R2),
        ("lambda-audit", "stack-problem-deploy", "lambda", "AWS Lambda\n監査の記録・ExternalId の点検", 3900, R2),
        ("eventbridge-problem-deploy", "stack-problem-deploy", "eventbridge", "Amazon EventBridge\nSBT バスのルール・スケジュール", 3100, R3),
        ("lambda-scoring", "stack-problem-deploy", "lambda", "AWS Lambda\n定期採点（GenericScoring）", 3500, R3),
        ("lambda-describe-stack", "stack-problem-deploy", "lambda", "AWS Lambda\nスタックの状態確認", 2900, R4),
        ("sfn-deploy", "stack-problem-deploy", "step_functions", "AWS Step Functions\n配置・削除・一括配置", 3100, R4),
        ("codebuild-rollback", "stack-problem-deploy", "codebuild", "AWS CodeBuild\n旧来の配置経路", 3300, R4),
        ("cloudwatch-ops-alarms", "stack-problem-deploy", "cloudwatch_2", "Amazon CloudWatch\n運用アラーム・SNS（任意）", 3700, R4),
        ("s3-competitor-bootstrap", "stack-problem-deploy", "s3", "Amazon S3\n競技用アカウントの初期設定", 3900, R4),
        ("ssm-external-id", "stack-problem-deploy", "systems_manager", "AWS Systems Manager\nParameter Store（ExternalId）", 2900, R5),
        ("lambda-cfn-deploy", "stack-problem-deploy", "lambda", "AWS Lambda\nスタック操作（CfnDeploy）", 3100, R5),
        ("s3-bulk-plan", "stack-problem-deploy", "s3", "Amazon S3\n一括配置の計画", 2900, R6),
        ("cloudwatch-deploy-logs", "stack-problem-deploy", "cloudwatch_2", "Amazon CloudWatch\n配置ジョブのログ（参加者 API が読む）", 3300, R6),
        ("iam-github-oidc", "stack-challenge-payload", "identity_and_access_management", "AWS IAM\nGitHub OIDC 用ロール", 4300, R0),
        ("s3-challenge-payload", "stack-challenge-payload", "s3", "Amazon S3\n非公開の問題データ", 4300, R1),
        ("idp", "external", "corporate_data_center", "社内・テナントの IdP\n（SAML 2.0、任意）", 4680, 460),
        ("turso", "external", "traditional_server", "Turso（libSQL）\n制御データの代替（任意）", 4680, 630),
        ("non-aws-providers", "external", "traditional_server", "AWS 以外のクラウド\nAzure・GCP・さくら（画面は既定で非表示）", 4680, 800),
        ("github-actions", "external", "traditional_server", "GitHub Actions\n（該当ワークフローは今なし）", 4920, 970),
        ("iam-competitor", "competitor-account", "identity_and_access_management", "AWS IAM\nTenkaCloud-CompetitorDeploy-Role", 4700, R5),
        ("cfn-problem", "competitor-account", "cloudformation", "AWS CloudFormation\n問題のスタック（チーム×問題）", 4940, R5),
        ("problem-resources", "competitor-account", "general", "問題のリソース\n（テンプレートで定義）", 4940, R6),
    ]
    d = Diagram(frames, icons, align_bottoms=("aws-tenkacloud", "external"))
    e = d.edge

    # 利用者
    e("user-system-admin", ("left",), "cloudfront-admin", ("top",), "画面（HTTPS）", via=[(630, YU)])
    e("user-system-admin", ("bottom",), "apigw-control-plane", ("top",), "API（JWT）", lab=(0, 0.727))
    e("user-system-admin", ("right",), "apigw-insight", ("top",), "閲覧・復旧 API（JWT）", via=[(1760, YU)])
    e("user-operator", ("bottom",), "cloudwatch-dashboard", ("right",), "監視・復旧", via=[(1865, R3)], lab=(0, 0.944))
    e("user-organizer", ("left",), "cloudfront-organizer", ("top",), "画面（HTTPS）", via=[(2230, YU)])
    e("user-organizer", ("bottom",), "apigw-tenant", ("top",), "API（JWT）", lab=(0, 0.727))
    e("user-participants", ("left",), "cloudfront-portal", ("top",), "画面（HTTPS）", via=[(3300, YU)])
    e("user-participants", ("bottom",), "lambda-portal", ("top",), "API（チームのキー）", lab=(0, 0.727))
    e("user-participants", ("right", 0.75), "lambda-coordination", ("top",), "独自競技の操作", via=[(3700, 75)], lab=(1, 0.748))
    e("user-participants", ("right", 0.25), "problem-resources", ("right",), "問題への解答操作", via=[(5190, 45), (5190, R6)], pos=-0.7)
    e("user-author", ("bottom",), "github-actions", ("right",), "公開", via=[(5300, 970)])

    # 管理コンソールの配信と設定
    e("cloudfront-admin", ("bottom",), "s3-admin", ("top",), "静的ファイル（OAI）")
    e("lambda-runtime-config", ("right",), "cloudfront-admin", ("left",), "キャッシュを無効化")
    e("lambda-runtime-config", ("bottom",), "s3-admin", ("left",), "runtime-config.json を配置", via=[(250, R1)], lab=(1, 0.6))

    # テナントの登録
    e("apigw-control-plane", ("right",), "cognito-system-admin", ("left",), "JWT を検証", aux=True)
    e("apigw-control-plane", ("bottom",), "lambda-sbt", ("top",), "テナントの操作")
    e("lambda-sbt", ("left",), "dynamodb-tenant-details", ("right",), "読み書き")
    e("lambda-sbt", ("right",), "eventbridge-sbt", ("left",), "オンボーディング")
    e("eventbridge-sbt", ("bottom",), "eventbridge-bootstrap", ("top",), "同じバス", lab=(0, 0.1))
    e("eventbridge-bootstrap", ("left",), "sfn-lifecycle", ("right",), "ルールの宛先")
    e("sfn-lifecycle", ("bottom",), "codebuild-lifecycle", ("top",), "RUN_JOB・完了待ち")
    e("codebuild-lifecycle", ("left",), "dynamodb-tenant-mapping", ("right",), "対応表を読む（撤去時）")
    e("codebuild-lifecycle", ("right",), "stack-tenant-template", ("bottom", 2100), "silo は作成・pooled は再利用", via=[(2100, R4)], pos=-0.4)
    e("lambda-reconciler", ("top",), "dynamodb-tenant-mapping", ("bottom",), "2 分ごとに突き合わせ")
    e("lambda-tenant-mapping", ("bottom",), "dynamodb-tenant-mapping", ("left",), "対応表に登録", via=[(1990, 893), (740, 893), (740, R4)], lab=(0, 0.6))

    # 管理者向けの閲覧
    e("apigw-insight", ("bottom",), "lambda-insight", ("top",), "呼び出し")

    # プラットフォームの更新
    e("s3-source", ("right",), "codepipeline", ("left",), "ソース")
    e("codepipeline", ("bottom",), "lambda-prep-deploy", ("top",), "配置の準備")
    e("codepipeline", ("right",), "sfn-wave", ("left",), "ウェーブを実行")
    e("sfn-wave", ("right",), "codebuild-update-tenant", ("left",), "テナントごとに更新")
    e("codebuild-update-tenant", ("top",), "stack-tenant-template", ("bottom", 2230), "スタックを更新", pos=0.4)

    # 開催管理
    e("cloudfront-organizer", ("bottom",), "s3-organizer", ("top",), "静的ファイル（OAI）")
    e("apigw-tenant", ("right",), "cognito-tenant", ("left",), "JWT を検証", aux=True)
    e("apigw-tenant", ("bottom",), "lambda-api", ("left",), "Lambda 統合（スタックをまたぐ）", via=[(2450, R2)], lab=(1, 0.3))

    # 外部の信頼境界（リージョンの上の帯を通す。遠くへ行く線ほど上、帯の右の通り道は外側ほど右）
    e("idp", ("left", 0.25), "cognito-system-admin", ("top",), "SAML アサーション", via=[(4515, 445), (4515, BAND_A), (1310, BAND_A)], lab=(3, 0.7))
    e("idp", ("left", 0.75), "cognito-tenant", ("top",), "SAML（silo のみ）", via=[(4500, 475), (4500, BAND_B), (2670, BAND_B)], lab=(3, 0.68))
    e("lambda-api", ("top", 0.25), "turso", ("left",), "libSQL（Turso 構成のとき）", via=[(3085, BAND_D), (4480, BAND_D), (4480, 630)], lab=(1, 0.548))
    e("lambda-api", ("top", 0.75), "non-aws-providers", ("left",), "AWS 以外への配置", via=[(3115, BAND_E), (4465, BAND_E), (4465, 800)], lab=(1, 0.767))
    e("github-actions", ("left",), "iam-github-oidc", ("top",), "OIDC で引き受け", via=[(4445, 970), (4445, BAND_C), (4300, BAND_C)], lab=(2, 0.5))
    e("iam-github-oidc", ("bottom",), "s3-challenge-payload", ("top",), "PutObject のみ")

    # 問題の配置と参加者
    e("cloudfront-portal", ("bottom",), "s3-portal", ("top",), "静的ファイル（OAI）")
    e("lambda-portal", ("bottom",), "dynamodb-control", ("top",), "読み書き")
    e("lambda-coordination", ("right",), "s3-coordination", ("left",), "プラグインを読む")
    e("lambda-api", ("right",), "dynamodb-control", ("left",), "読み書き")
    e("lambda-audit", ("left",), "dynamodb-control", ("right",), "監査ログ")
    e("lambda-api", ("bottom",), "eventbridge-problem-deploy", ("top",), "Deploy*Requested")
    e("eventbridge-problem-deploy", ("bottom",), "sfn-deploy", ("top",), "ルールの宛先")
    e("eventbridge-problem-deploy", ("right",), "lambda-scoring", ("left",), "1 分ごとに起動")
    e("lambda-scoring", ("top",), "dynamodb-control", ("bottom",), "得点を記録")
    e("lambda-scoring", ("right",), "lambda-coordination", ("bottom",), "tick を委譲", via=[(3700, R3)], pos=-0.3)
    e("lambda-scoring", ("bottom", 0.25), "problem-resources", ("left",), "HTTP(S) で確認", via=[(3485, R6)], pos=0.2)
    e("lambda-scoring", ("bottom", 0.75), "cloudwatch-ops-alarms", ("left",), "エラー・停止", aux=True, via=[(3515, R4)])
    e("sfn-deploy", ("bottom",), "lambda-cfn-deploy", ("top",), "スタック操作")
    e("sfn-deploy", ("left",), "lambda-describe-stack", ("right",), "状態を確認")
    e("sfn-deploy", ("right",), "codebuild-rollback", ("left",), "Lambda 経路を切ったとき", aux=True)
    e("lambda-cfn-deploy", ("left",), "ssm-external-id", ("right",), "ExternalId を取得")
    e("lambda-cfn-deploy", ("right",), "iam-competitor", ("left",), "AssumeRole（ExternalId 必須）")
    e("lambda-cfn-deploy", ("bottom", 0.25), "s3-source", ("bottom",), "テンプレートと metadata を読む", via=[(3085, 1670), (1540, 1670)], lab=(1, 0.5))
    e("lambda-cfn-deploy", ("bottom", 0.75), "cloudwatch-deploy-logs", ("left",), "進捗ログ", via=[(3115, R6)], pos=0.4)
    e("s3-competitor-bootstrap", ("right",), "iam-competitor", ("top",), "初期設定テンプレート（1 回だけ）", aux=True, via=[(4700, R4)], pos=-0.3)
    e("iam-competitor", ("right",), "cfn-problem", ("left",), "CloudFormation API")
    e("cfn-problem", ("bottom",), "problem-resources", ("top",), "作成・更新・削除")
    return d


def lite():
    # Lite は SaaS の右半分に近い。stack は 2 つで、SBT・テナントのライフサイクルは無い。
    frames = [
        ("aws-lite", "1", "AWS Cloud", CLOUD, 20, 2220, 130),
        ("region-lite", "aws-lite", "AWS Region — Lite deployment account", REGION, 40, 2200, 300, 1820),
        ("stack-lite", "region-lite", "TenkaCloudLiteStack", TENANT_STACK, 60, 950, 360),
        ("stack-problem-deploy", "region-lite", "ProblemDeployBackendStack", BACKEND_STACK, 980, 2180, 360),
        ("external", "1", "External boundaries", EXTERNAL, 2320, 2920, 130),
        ("competitor-account", "external", "Competitor AWS account", BACKEND_STACK, 2360, 2880, 1080),
    ]
    icons = [
        ("user-organizer", "1", "user", "開催者", 640, YU),
        ("user-participants", "1", "users", "参加者", 1690, YU),
        ("lambda-pre-token", "stack-lite", "lambda", "AWS Lambda\n管理者 claims の追加", 200, R1),
        ("cognito-tenant", "stack-lite", "cognito", "Amazon Cognito\n開催者（tenant=local）", 420, R1),
        ("apigw-tenant", "stack-lite", "api_gateway", "Amazon API Gateway\nテナント REST API", 640, R1),
        ("cloudfront-organizer", "stack-lite", "cloudfront", "Amazon CloudFront\n開催管理コンソール", 860, R0),
        ("s3-organizer", "stack-lite", "s3", "Amazon S3\n開催管理コンソール", 860, R1),
        ("dynamodb-saml", "stack-lite", "dynamodb", "Amazon DynamoDB\nSamlIdps", 200, R2),
        ("lambda-saml", "stack-lite", "lambda", "AWS Lambda\nSAML IdP の管理", 420, R2),
        ("cloudfront-portal", "stack-problem-deploy", "cloudfront", "Amazon CloudFront\n参加者ポータル", 1490, R0),
        ("s3-portal", "stack-problem-deploy", "s3", "Amazon S3\n参加者ポータル", 1490, R1),
        ("lambda-portal", "stack-problem-deploy", "lambda", "AWS Lambda\n参加者 API（関数 URL）", 1690, R1),
        ("lambda-coordination", "stack-problem-deploy", "lambda", "AWS Lambda\n独自競技の中継（関数 URL）", 1890, R1),
        ("s3-coordination", "stack-problem-deploy", "s3", "Amazon S3\n独自競技のプラグイン", 2090, R1),
        ("lambda-api", "stack-problem-deploy", "lambda", "AWS Lambda\n配置・大会・アカウント API", 1290, R2),
        ("dynamodb-control", "stack-problem-deploy", "dynamodb", "Amazon DynamoDB\n制御データ（7 テーブル）", 1690, R2),
        ("lambda-audit", "stack-problem-deploy", "lambda", "AWS Lambda\n監査の記録・ExternalId の点検", 2090, R2),
        ("eventbridge-problem-deploy", "stack-problem-deploy", "eventbridge", "Amazon EventBridge\nこの stack のイベントバス・スケジュール", 1290, R3),
        ("lambda-scoring", "stack-problem-deploy", "lambda", "AWS Lambda\n定期採点（GenericScoring）", 1690, R3),
        ("lambda-describe-stack", "stack-problem-deploy", "lambda", "AWS Lambda\nスタックの状態確認", 1090, R4),
        ("sfn-deploy", "stack-problem-deploy", "step_functions", "AWS Step Functions\n配置・削除・一括配置", 1290, R4),
        ("codebuild-rollback", "stack-problem-deploy", "codebuild", "AWS CodeBuild\n旧来の配置経路", 1490, R4),
        ("cloudwatch-ops-alarms", "stack-problem-deploy", "cloudwatch_2", "Amazon CloudWatch\n運用アラーム・SNS（任意）", 1890, R4),
        ("s3-competitor-bootstrap", "stack-problem-deploy", "s3", "Amazon S3\n競技用アカウントの初期設定", 2090, R4),
        ("ssm-external-id", "stack-problem-deploy", "systems_manager", "AWS Systems Manager\nParameter Store（ExternalId）", 1090, R5),
        ("lambda-cfn-deploy", "stack-problem-deploy", "lambda", "AWS Lambda\nスタック操作（CfnDeploy）", 1290, R5),
        ("s3-bulk-plan", "stack-problem-deploy", "s3", "Amazon S3\n一括配置の計画", 1090, R6),
        ("cloudwatch-deploy-logs", "stack-problem-deploy", "cloudwatch_2", "Amazon CloudWatch\n配置ジョブのログ（参加者 API が読む）", 1490, R6),
        ("s3-source", "region-lite", "s3", "Amazon S3\nソースバケット（problems/・pack-problems/）", 1290, 1690),
        ("idp", "external", "corporate_data_center", "テナントの IdP\n（SAML 2.0、任意）", 2470, 460),
        ("turso", "external", "traditional_server", "Turso（libSQL）\n制御データの代替（任意）", 2470, 630),
        ("non-aws-providers", "external", "traditional_server", "AWS 以外のクラウド\nAzure・GCP・さくら（画面は既定で非表示）", 2470, 800),
        ("iam-competitor", "competitor-account", "identity_and_access_management", "AWS IAM\nTenkaCloud-CompetitorDeploy-Role", 2490, R5),
        ("cfn-problem", "competitor-account", "cloudformation", "AWS CloudFormation\n問題のスタック（チーム×問題）", 2730, R5),
        ("problem-resources", "competitor-account", "general", "問題のリソース\n（テンプレートで定義）", 2730, R6),
    ]
    d = Diagram(frames, icons, align_bottoms=("aws-lite", "external"))
    e = d.edge

    # 利用者
    e("user-organizer", ("right",), "cloudfront-organizer", ("top",), "画面（HTTPS）", via=[(860, YU)])
    e("user-organizer", ("bottom",), "apigw-tenant", ("top",), "API（JWT）", lab=(0, 0.727))
    e("user-participants", ("left",), "cloudfront-portal", ("top",), "画面（HTTPS）", via=[(1490, YU)])
    e("user-participants", ("bottom",), "lambda-portal", ("top",), "API（チームのキー）", lab=(0, 0.727))
    e("user-participants", ("right", 0.75), "lambda-coordination", ("top",), "独自競技の操作", via=[(1890, 75)], lab=(1, 0.748))
    e("user-participants", ("right", 0.25), "problem-resources", ("right",), "問題への解答操作", via=[(2980, 45), (2980, R6)], pos=-0.7)

    # 開催管理（TenkaCloudLiteStack）
    e("cloudfront-organizer", ("bottom",), "s3-organizer", ("top",), "静的ファイル（OAI）")
    e("apigw-tenant", ("left",), "cognito-tenant", ("right",), "JWT を検証", aux=True)
    e("cognito-tenant", ("left",), "lambda-pre-token", ("right",), "claims を追加")
    e("apigw-tenant", ("bottom", 0.25), "lambda-saml", ("right",), "/tenant/idp", via=[(625, R2)])
    e("lambda-saml", ("top",), "cognito-tenant", ("bottom",), "IdP を登録")
    e("lambda-saml", ("left",), "dynamodb-saml", ("right",), "読み書き")
    e("apigw-tenant", ("bottom", 0.75), "lambda-api", ("left",), "Lambda 統合（スタックをまたぐ）", via=[(655, R2)], lab=(1, 0.2))

    # 外部の信頼境界（リージョンの上の帯を通す）
    e("idp", ("left",), "cognito-tenant", ("top",), "SAML アサーション", via=[(2305, 460), (2305, BAND_A), (420, BAND_A)], lab=(3, 0.7))
    e("lambda-api", ("top", 0.25), "turso", ("left",), "libSQL（Turso 構成のとき）", via=[(1275, BAND_B), (2285, BAND_B), (2285, 630)], lab=(1, 0.6))
    e("lambda-api", ("top", 0.75), "non-aws-providers", ("left",), "AWS 以外への配置", via=[(1305, BAND_D), (2265, BAND_D), (2265, 800)], lab=(1, 0.75))

    # 問題の配置と参加者
    e("cloudfront-portal", ("bottom",), "s3-portal", ("top",), "静的ファイル（OAI）")
    e("lambda-portal", ("bottom",), "dynamodb-control", ("top",), "読み書き")
    e("lambda-coordination", ("right",), "s3-coordination", ("left",), "プラグインを読む")
    e("lambda-api", ("right",), "dynamodb-control", ("left",), "読み書き")
    e("lambda-audit", ("left",), "dynamodb-control", ("right",), "監査ログ")
    e("lambda-api", ("bottom",), "eventbridge-problem-deploy", ("top",), "Deploy*Requested")
    e("eventbridge-problem-deploy", ("bottom",), "sfn-deploy", ("top",), "ルールの宛先")
    e("eventbridge-problem-deploy", ("right",), "lambda-scoring", ("left",), "1 分ごとに起動")
    e("lambda-scoring", ("top",), "dynamodb-control", ("bottom",), "得点を記録")
    e("lambda-scoring", ("right",), "lambda-coordination", ("bottom",), "tick を委譲", via=[(1890, R3)], pos=-0.3)
    e("lambda-scoring", ("bottom", 0.25), "problem-resources", ("left",), "HTTP(S) で確認", via=[(1675, R6)], pos=0.2)
    e("lambda-scoring", ("bottom", 0.75), "cloudwatch-ops-alarms", ("left",), "エラー・停止", aux=True, via=[(1705, R4)])
    e("sfn-deploy", ("bottom",), "lambda-cfn-deploy", ("top",), "スタック操作")
    e("sfn-deploy", ("left",), "lambda-describe-stack", ("right",), "状態を確認")
    e("sfn-deploy", ("right",), "codebuild-rollback", ("left",), "Lambda 経路を切ったとき", aux=True)
    e("lambda-cfn-deploy", ("left",), "ssm-external-id", ("right",), "ExternalId を取得")
    e("lambda-cfn-deploy", ("right",), "iam-competitor", ("left",), "AssumeRole（ExternalId 必須）")
    e("lambda-cfn-deploy", ("bottom", 0.25), "s3-source", ("top", 0.25), "テンプレートと metadata を読む", lab=(0, 0.92))
    e("lambda-cfn-deploy", ("bottom", 0.75), "cloudwatch-deploy-logs", ("left",), "進捗ログ", via=[(1305, R6)], pos=0.4)
    e("s3-competitor-bootstrap", ("right",), "iam-competitor", ("top",), "初期設定テンプレート（1 回だけ）", aux=True, via=[(2490, R4)], pos=-0.3)
    e("iam-competitor", ("right",), "cfn-problem", ("left",), "CloudFormation API")
    e("cfn-problem", ("bottom",), "problem-resources", ("top",), "作成・更新・削除")
    return d


def local():
    # make local（参加者の練習）と make local-dev（開発者）の実行時の構成。AWS のリソースは作らない。
    r0, r1, r2, r3 = 360, 530, 700, 870
    frames = [
        ("local-play", "1", "make local（参加者の練習・Docker だけ）", lane("#F7FCF9", "#2E7B50", 16), 20, 1880, 130),
        ("host", "local-play", "Host OS / active Docker context", lane("#FFFFFF", "#405A78", 15, 1), 40, 1860, 190),
        ("tenkacloud-local", "host", "tenkacloud-local（uid 1000）", CONSOLE_STACK, 280, 1140, 250),
        ("problem-compose", "host", "問題の Compose（tc-local-<問題 ID>）", BACKEND_STACK, 1400, 1840, 420),
        ("local-dev", "1", "make local-dev（開発者）", lane("#FBF9FF", "#7652B6", 16), 1920, 2880, 130),
    ]
    icons = [
        ("browser", "1", "client", "参加者のブラウザ", 590, YU),
        ("data-permissions", "host", "container_1", "local-data-permissions\n最初に 1 回・uid 0", 150, r0),
        ("sqlite", "tenkacloud-local", "generic_database", "SQLite\n/data（named volume）", 370, r0),
        ("http", "tenkacloud-local", "traditional_server", "Bun HTTP サーバー\nポータル・API（127.0.0.1:5175）\n読み取り専用 rootfs・host network", 590, r0),
        ("scoring", "tenkacloud-local", "gear", "採点\n/verify の結果で加点・履歴", 810, r0),
        ("problems", "tenkacloud-local", "documents", "problems/（読み取り専用）\nverify・multi-verify の Compose 問題", 370, r1),
        ("lifecycle", "tenkacloud-local", "gear", "ProblemLifecycle\n起動・停止（同時 3 件・LRU）", 590, r1),
        ("terminal", "tenkacloud-local", "traditional_server", "Terminal WebSocket\ncompose exec（1 問 4 セッション）", 1030, r1),
        ("runner", "tenkacloud-local", "gear", "ContainerRunner\ndocker CLI・Compose v2", 590, r2),
        ("docker-sock", "host", "disk", "docker.sock\n（:ro でも root 相当）", 1260, r2),
        ("problem-container", "problem-compose", "container_1", "問題コンテナ\n挑戦用ポート・POST /verify\n秘密値は配置先の鍵から導出", 1720, r1),
        ("developer", "1", "user", "開発者", 2240, YU),
        ("vite", "local-dev", "traditional_server", "Vite\nポータル（127.0.0.1:5175）", 2240, r0),
        ("api", "local-dev", "traditional_server", "tenkacloud local\nAPI（空きポート）", 2460, r0),
        ("store", "local-dev", "generic_database", "SQLite（.tenkacloud/local）\nまたは Turso", 2680, r0),
        ("docker-host", "local-dev", "container_1", "ホストの docker CLI\ntc-local-* の Compose 問題", 2240, r1),
        ("classifier", "local-dev", "gear", "ランタイムの振り分け\n黙って別の実行方法に変えない", 2460, r1),
        ("records", "local-dev", "document", "非公開のセッション記録\natomic write・復旧で突き合わせ", 2240, r2),
        ("sim-runtime", "local-dev", "gear", "SimulatorLocalRuntime\nTENKACLOUD_LOCAL_SIMULATOR=1", 2460, r2),
        ("simulator", "local-dev", "container_2", "TenkaCloud Simulator\nGHCR・digest 固定\nprotocol 2026-07-11", 2680, r2),
        ("listeners", "local-dev", "traditional_server", "loopback のデータプレーン\n参加者向けの出力だけ", 2460, r3),
    ]
    d = Diagram(frames, icons)
    e = d.edge
    e("browser", ("bottom",), "http", ("top",), "http://127.0.0.1:5175", lab=(0, 0.95))
    e("browser", ("right", 0.75), "terminal", ("top",), "WebSocket（一回限りのチケット）", via=[(1030, 75)], lab=(0, 0.5))
    e("browser", ("right", 0.25), "problem-container", ("top", 0.75), "挑戦用ポート（127.0.0.1）", via=[(1735, 45)], lab=(0, 0.6))
    e("data-permissions", ("right",), "sqlite", ("left",), "所有者を調整", aux=True)
    e("http", ("left", 0.25), "sqlite", ("right", 0.25), "読み書き")
    e("http", ("left", 0.75), "problems", ("right",), "カタログ", via=[(450, r0 + 15), (450, r1)], lab=(0, 0.5))
    e("http", ("right",), "scoring", ("left",), "解答を渡す")
    e("http", ("bottom",), "lifecycle", ("top",), "起動・停止")
    e("lifecycle", ("bottom",), "runner", ("top",), "docker compose")
    e("runner", ("right", 0.75), "docker-sock", ("left", 0.75), "up・down")
    e("terminal", ("bottom",), "docker-sock", ("left", 0.25), "compose exec", via=[(1030, r2 - 15)])
    e("docker-sock", ("right",), "problem-container", ("bottom",), "起動・停止・exec", via=[(1720, r2)], lab=(0, 0.5))
    e("scoring", ("right",), "problem-container", ("top", 0.25), "POST /verify（loopback）", via=[(1705, r0)], lab=(0, 0.5))
    e("developer", ("bottom",), "vite", ("top",), "画面", lab=(0, 0.95))
    e("developer", ("right",), "api", ("top",), "API", via=[(2460, YU)])
    e("api", ("right",), "store", ("left",), "読み書き")
    e("api", ("bottom",), "classifier", ("top",), "カタログ")
    e("classifier", ("left",), "docker-host", ("right",), "Compose 問題")
    e("classifier", ("bottom",), "sim-runtime", ("top",), "cloud・Composite 問題")
    e("sim-runtime", ("right",), "simulator", ("left",), "deploy・delete（HTTP）")
    e("sim-runtime", ("left",), "records", ("right",), "記録")
    e("sim-runtime", ("bottom",), "listeners", ("top",), "出力を公開")
    return d


USE_CASE = "rounded=1;arcSize=20;whiteSpace=wrap;html=1;fillColor=#F8FAFC;strokeColor=#405A78;strokeWidth=1.5;fontColor=#16191F;fontSize=12;align=center;verticalAlign=middle"


def use_cases():
    # 誰が何をできるか。2 行目に使えるモードを書く。関連は UML と同じく矢印の無い直線にする。
    rows = [230 + i * 90 for i in range(16)]
    left = [
        ("uc-tenant", "テナントを作成・削除する（停止は表示だけ）\nSaaS"),
        ("uc-insight", "全テナントの状態・監査・ジョブ・費用を見る\nSaaS（Admin Insight）"),
        ("uc-cp-saml", "コントロールプレーンの SAML IdP を管理する\nSaaS（既定で非表示）"),
        ("uc-event", "大会・チーム・日程を管理する（作成・配置・終了・アーカイブ）\nSaaS・Lite・local-host"),
        ("uc-team-key", "チームキーを発行・再発行・配布する\nSaaS・Lite・local-host"),
        ("uc-competitor", "競技用アカウントを登録・検証・削除する\nSaaS・Lite（ExternalId は再登録で変える）"),
        ("uc-deploy", "問題を配置・再試行・撤去する（画面はイベント単位）\nSaaS・Lite・local-host"),
        ("uc-disruption", "障害を発火する（復旧は自動・定期障害は早期に解除できる）\nSaaS・Lite・Local"),
        ("uc-notify", "通知を送る・採点をロックする\nSaaS・Lite・local-host"),
        ("uc-users", "ユーザーと SAML IdP を管理する（TenantAdmin だけ）\nユーザー: SaaS・Lite / SAML: silo・Lite（既定で非表示）"),
        ("uc-login", "チームキーでログインする\nSaaS・Lite・local-host（Local はキーが入力済み）"),
        ("uc-play", "問題を使う（自分で起動するのは Local だけ）\nSaaS・Lite・Local・local-host"),
        ("uc-submit", "解答を送り、得点・ヒント・順位を見る\nSaaS・Lite・Local・local-host"),
        ("uc-console", "チームの AWS コンソールを開く\nSaaS・Lite"),
        ("uc-coordination", "独自競技の操作を送る（HUNT など）\nSaaS・Lite・local-host"),
        ("uc-terminal", "ターミナル・シミュレーターを使う\nLocal（対応する問題）"),
    ]
    right = [
        (0, "uc-commit", "問題リポジトリに commit し CI で検証する\nTenkaCloudChallenge"),
        (1, "uc-pack", "Problem Pack を検証・導入・有効化する\nPack CLI（Lite）"),
        (2, "uc-practice", "AWS なしで練習・検証する\nmake local・local-host・make dev"),
        (3, "uc-payload", "非公開の問題データを公開する\nSaaS（基盤だけ・今は未使用）"),
        (5, "uc-bootstrap", "初期設定のスタックを作成する（Launch Stack）\nSaaS・Lite"),
        (7, "uc-platform", "基盤を配置・撤去する\nmake deploy・destroy"),
        (8, "uc-cleanup", "失敗の後片付けをする\nmake・scripts"),
        (10, "uc-machine", "API で問題を配置・再試行する\nSaaS（machine API・既定で無効）"),
    ]
    frames = [("tenkacloud", "1", "TenkaCloud", lane("#FFFFFF", "#232F3E", 16), 330, 2110, 130)]
    boxes = [(bid, "tenkacloud", label, 780, rows[i], 720, 64, USE_CASE) for i, (bid, label) in enumerate(left)]
    boxes += [(bid, "tenkacloud", label, 1680, rows[i], 720, 64, USE_CASE) for i, bid, label in right]
    icons = [
        ("actor-system-admin", "1", "user", "システム管理者", 170, rows[1]),
        ("actor-organizer", "1", "user", "開催者\n（TenantAdmin・TenantOperator）", 170, rows[6]),
        ("actor-participant", "1", "users", "参加者", 170, (rows[12] + rows[13]) / 2),
        ("actor-author", "1", "user", "問題作成者（CI）", 2260, (rows[1] + rows[2]) / 2),
        ("actor-owner", "1", "user", "競技用アカウントの所有者", 2260, rows[5]),
        ("actor-operator", "1", "user", "運用者\n（AWS 権限で make を実行）", 2260, (rows[7] + rows[8]) / 2),
        ("actor-machine", "1", "client", "外部ツール\n（tcloud CLI）", 2260, rows[10]),
    ]
    d = Diagram(frames, icons, boxes)
    owners = {"actor-system-admin": range(0, 3), "actor-organizer": range(3, 10), "actor-participant": range(10, 16)}
    for actor, idx in owners.items():
        for i in idx:
            d.edge(actor, ("right",), left[i][0], ("left",), "", straight=True, arrow=False)
    right_owner = {"uc-commit": "actor-author", "uc-pack": "actor-author", "uc-practice": "actor-author", "uc-payload": "actor-author",
                   "uc-bootstrap": "actor-owner", "uc-platform": "actor-operator", "uc-cleanup": "actor-operator", "uc-machine": "actor-machine"}
    for bid, actor in right_owner.items():
        d.edge(actor, ("left",), bid, ("right",), "", straight=True, arrow=False)
    d.edge("uc-event", ("right",), "uc-deploy", ("right",), "含む（include）", aux=True, via=[(1210, rows[3]), (1210, rows[6])], lab=(1, 0.5))
    return d


MODE = "rounded=1;arcSize=12;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#405A78;strokeWidth=1.5;fontColor=#16191F;fontSize=13;align=center;verticalAlign=middle"


def context():
    # TenkaCloud を 1 つの枠にし、4 つのモードと、人・外部システムとのつながりだけを描く。
    frames = [
        ("tenkacloud", "1", "TenkaCloud", lane("#FFFFFF", "#232F3E", 16), 700, 1760, 200, 1400),
        ("aws-account", "tenkacloud", "AWS アカウント（SaaS・Lite）", lane("#FFFFFF", "#147EBA", 15, 1), 740, 1720, 260, 800),
        ("pc", "tenkacloud", "PC（Local・local-host）", lane("#FAFBFC", "#405A78", 15, 1), 740, 1720, 840, 1380),
    ]
    boxes = [
        ("mode-saas", "aws-account", "SaaS\n複数の組織（SBT で組織を管理・pooled / silo）", 1230, 460, 880, 90, MODE),
        ("mode-lite", "aws-account", "Lite\n1 つの組織（tenant=local・stack 2 つ）", 1230, 620, 880, 90, MODE),
        ("mode-local", "pc", "Local（make local・make local-dev）\n1 人の練習・Docker・Simulator は開発者が有効にしたときだけ", 1230, 980, 880, 90, MODE),
        ("mode-local-host", "pc", "local-host（make host）\n1 台の PC で複数チームの大会（Bun + SQLite）", 1230, 1140, 880, 90, MODE),
    ]
    icons = [
        ("participant", "1", "users", "参加者", 200, 330),
        ("system-admin", "1", "user", "システム管理者", 200, 460),
        ("operator", "1", "user", "運用者（AWS 権限）", 200, 690),
        ("organizer", "1", "user", "開催者", 200, 1000),
        ("author", "1", "user", "問題作成者（CI）", 200, 1300),
        ("competitor", "1", "general", "競技用の AWS アカウント\n（チームごと）", 2150, 330),
        ("idp", "1", "corporate_data_center", "社内・テナントの IdP\n（SAML 2.0、任意）", 2150, 460),
        ("non-aws", "1", "internet", "AWS 以外のクラウド\nAzure・GCP・さくら", 2150, 590),
        ("email", "1", "email", "メール\n（SNS の通知・Cognito の招待）", 2150, 720),
        ("turso", "1", "generic_database", "Turso（libSQL）\n制御データの代替（任意）", 2150, 880),
        ("ghcr", "1", "container_2", "GHCR\nSimulator のイメージ", 2150, 1030),
        ("challenge", "1", "documents", "TenkaCloudChallenge\n（GitHub・submodule）", 2150, 1300),
        ("packs", "1", "documents", "Problem Pack の\nリポジトリ", 2430, 1300),
    ]
    d = Diagram(frames, icons, boxes)
    e = d.edge
    e("participant", ("right",), "tenkacloud", ("left", 330), "解答・得点（チームキー）")
    e("participant", ("top",), "competitor", ("top",), "問題の操作・AWS コンソール", via=[(200, 150), (2150, 150)], lab=(1, 0.5))
    e("system-admin", ("right",), "mode-saas", ("left",), "組織の登録・監視")
    e("operator", ("right",), "aws-account", ("left", 690), "make deploy・destroy")
    e("organizer", ("right",), "tenkacloud", ("left", 1000), "大会の運営")
    e("author", ("bottom", 0.25), "challenge", ("bottom",), "commit・CI", via=[(185, 1500), (2150, 1500)], lab=(1, 0.5))
    e("author", ("bottom", 0.75), "packs", ("bottom",), "commit", via=[(215, 1530), (2430, 1530)], lab=(1, 0.85))
    e("aws-account", ("right", 330), "competitor", ("left",), "AssumeRole（ExternalId 必須）・CloudFormation")
    e("idp", ("left",), "aws-account", ("right", 460), "SAML アサーション")
    e("aws-account", ("right", 590), "non-aws", ("left",), "provider REST（GCP は token exchange）")
    e("aws-account", ("right", 720), "email", ("left",), "通知・招待")
    e("tenkacloud", ("right", 880), "turso", ("left",), "libSQL（任意）")
    e("pc", ("right", 1030), "ghcr", ("left",), "イメージを取得（local-dev）")
    e("challenge", ("left",), "tenkacloud", ("right", 1300), "問題（CDK synth 時に読む）")
    e("packs", ("top",), "tenkacloud", ("right", 1200), "Problem Pack（Lite・snapshot）", via=[(2430, 1200)])
    return d


def replace_page(text, page_id, model):
    pattern = re.compile(rf'(<diagram id="{page_id}"[^>]*>)(.*?)(</diagram>)', re.S)
    assert len(pattern.findall(text)) == 1, f"{page_id} のページが 1 つだけ見つからない"
    return pattern.sub(lambda m: m.group(1) + "\n        " + model + "\n    " + m.group(3), text)


def build():
    text = SRC.read_text(encoding="utf-8")
    text = replace_page(text, "saas-physical", saas().model())
    text = replace_page(text, "lite-physical", lite().model())
    text = replace_page(text, "local-runtime", local().model())
    text = replace_page(text, "use-cases", use_cases().model())
    text = replace_page(text, "system-context", context().model())
    OUT.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    build()
