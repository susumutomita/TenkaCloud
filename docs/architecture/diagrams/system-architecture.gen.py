"""既存の system-architecture.drawio の 5 ページを現行実装に合わせて更新する。

元の mxfile・ページ ID、AWS4 公式アイコン、枠・ラベル・直角コネクタの書式を保つ。
旧 SaaS / Lite 固有のセルは現行の cloud / local 境界に置き換え、残るサービスは同じ ID を使う。
旧版の JAWS スライドは landing 側の固定済みコピーから書き出す。
座標は絶対座標で定義し、親の枠からの相対座標へ変換する。
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
        # Page extents include actors and labels outside frames (for example the participant CLI).
        label_half = lambda label: max(sum(12 if ord(c) > 0x2000 else 7 for c in line) for line in label.split("\n")) / 2
        width = max([r[2] for r in self.rect.values()] + [cx + max(HALF, label_half(label)) for _, _, _, label, cx, _ in self.icons]) + 100
        height = max([r[3] for r in self.rect.values()] + [cy + HALF + 16 * (label.count("\n") + 1) for _, _, _, label, _, cy in self.icons]) + 100
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


def cloud():
    # 実際の CloudApplicationStack / CloudDataStack。CloudFront と IAM はリージョン外。
    frames = [
        ("aws-tenkacloud", "1", "AWS Cloud（開催基盤アカウント）", CLOUD, 20, 2220, 130),
        ("region-tenkacloud", "aws-tenkacloud", "開催基盤リージョン", REGION, 40, 2200, 340),
        ("stack-admin-hosting", "region-tenkacloud", "CloudApplicationStack", CONSOLE_STACK, 60, 1390, 400),
        ("stack-problem-deploy", "region-tenkacloud", "CloudDataStack", BACKEND_STACK, 1420, 2180, 400),
    ]
    icons = [
        ("user-organizer", "1", "user", "開催者", 640, YU),
        ("user-participants", "1", "users", "参加者", 1690, YU),
        ("cloudfront-organizer", "aws-tenkacloud", "cloudfront", "Amazon CloudFront\n開催管理コンソール", 860, 220),
        ("cloudfront-portal", "aws-tenkacloud", "cloudfront", "Amazon CloudFront\n参加者ポータル", 1490, 220),
        ("s3-organizer", "stack-admin-hosting", "s3", "Amazon S3\n画面・runtime-config.json", 860, 490),
        ("s3-portal", "stack-problem-deploy", "s3", "Amazon S3\n画面・runtime-config.json", 1490, 490),
        ("cognito-tenant", "stack-admin-hosting", "cognito", "Amazon Cognito\n開催者認証・MFA", 300, R1),
        ("apigw-tenant", "stack-admin-hosting", "api_gateway", "Amazon API Gateway\n開催者・参加者 REST API", 640, R1),
        ("lambda-api", "stack-admin-hosting", "lambda", "AWS Lambda\n大会・認証・採点\nnative Cryptography Battle", 640, R2),
        ("dynamodb-control", "stack-problem-deploy", "dynamodb", "Amazon DynamoDB（3 テーブル）\nEvents・Teams・Deployments\n大会・ジョブ・得点・native state", 1690, R2),
        ("s3-source", "stack-admin-hosting", "s3", "Amazon S3\n固定カタログ・CFn・native plugin", 1090, R2),
        ("ssm-external-id", "stack-admin-hosting", "systems_manager", "AWS Systems Manager\nParameter Store（ExternalId）", 300, R3),
        ("lambda-dispatcher", "stack-admin-hosting", "lambda", "AWS Lambda\n永続キューの Dispatcher", 640, R4),
        ("eventbridge-problem-deploy", "stack-admin-hosting", "eventbridge", "Amazon EventBridge\n1 分ごとの起動", 300, R4),
        ("sfn-deploy", "stack-admin-hosting", "step_functions", "AWS Step Functions\nAWS 問題の配置・撤去", 640, R5),
        ("lambda-cfn-deploy", "stack-admin-hosting", "lambda", "AWS Lambda\nClaim・Create・Describe\nFinish・Fail", 1090, R5),
        ("cloudwatch-deploy-logs", "stack-admin-hosting", "cloudwatch_2", "Amazon CloudWatch\nAPI handler・Worker の診断\nWorkflow: ERROR（実行データなし）", 1090, R3),
    ]
    # Bootstrap 配信用 S3 は実際には ApplicationStack。02 の詳細図に描く。
    d = Diagram(frames, icons, align_bottoms=("stack-admin-hosting", "stack-problem-deploy"))
    e = d.edge
    e("user-organizer", ("right",), "cloudfront-organizer", ("top",), "画面（HTTPS）", via=[(860, YU)])
    e("user-organizer", ("left",), "cognito-tenant", ("top",), "ログイン", via=[(300, YU)], lab=(1, 0.76))
    e("user-organizer", ("bottom",), "apigw-tenant", ("top",), "開催者 JWT", lab=(0, 0.84))
    e("user-participants", ("left",), "cloudfront-portal", ("top",), "画面（HTTPS）", via=[(1490, YU)])
    e("user-participants", ("bottom",), "apigw-tenant", ("right",), "大会に属するチームキー", via=[(1690, R1)], lab=(1, 0.54))
    e("cloudfront-organizer", ("bottom",), "s3-organizer", ("top",), "静的ファイル（OAC）", lab=(0, 0.98))
    e("cloudfront-portal", ("bottom",), "s3-portal", ("top",), "静的ファイル（OAC）", lab=(0, 0.98))
    e("apigw-tenant", ("left",), "cognito-tenant", ("right",), "開催者 JWT を検証", aux=True)
    e("apigw-tenant", ("bottom",), "lambda-api", ("top",), "Lambda 統合")
    e("lambda-api", ("right",), "dynamodb-control", ("left",), "状態・得点を永続化", via=[(710, R2), (710, 930), (1580, 930), (1580, R2)], lab=(2, 0.5))
    e("lambda-api", ("right", 0.25), "s3-source", ("left", 0.25), "固定 artifact を読む")
    e("lambda-api", ("left",), "ssm-external-id", ("top",), "初回作成・取得", via=[(300, R2)], lab=(0, 0.5))
    e("eventbridge-problem-deploy", ("right",), "lambda-dispatcher", ("left",), "起動", aux=True)
    e("lambda-dispatcher", ("right",), "dynamodb-control", ("bottom", 0.25), "未処理ジョブを取得・照合", via=[(1675, R4)], lab=(0, 0.63))
    e("lambda-dispatcher", ("bottom",), "sfn-deploy", ("top",), "StartExecution")
    e("sfn-deploy", ("right",), "lambda-cfn-deploy", ("left",), "所有権付きの処理")
    e("lambda-api", ("bottom",), "cloudwatch-deploy-logs", ("left",), "API handler のログ", aux=True, via=[(640, R3)])
    e("lambda-cfn-deploy", ("top",), "cloudwatch-deploy-logs", ("bottom",), "Worker ログ", aux=True)
    return d


def aws_exercises():
    # プラットフォームと別の競技用アカウント。複数チームは同一競技用アカウントの別リージョンにも割り当て可能。
    frames = [
        ("aws-lite", "1", "AWS Cloud（開催基盤アカウント）", CLOUD, 20, 1760, 130),
        ("region-lite", "aws-lite", "開催基盤リージョン", REGION, 40, 1740, 300),
        ("stack-problem-deploy", "region-lite", "CloudApplicationStack / CloudDataStack", BACKEND_STACK, 60, 1720, 360),
        ("external", "1", "AWS Cloud（競技用アカウント・開催基盤とは分離）", EXTERNAL, 1860, 2730, 130),
        ("competitor-account", "external", "競技用リージョン（チームごとの割り当て）", REGION, 1880, 2710, 940),
    ]
    icons = [
        ("user-organizer", "1", "user", "開催者", 640, YU),
        ("user-participants", "1", "users", "参加者", 2490, YU),
        ("lambda-api", "stack-problem-deploy", "lambda", "AWS Lambda\n大会・ジョブを受理", 640, R0),
        ("dynamodb-control", "stack-problem-deploy", "dynamodb", "Amazon DynamoDB\n所有権・試行・永続キュー", 1090, R0),
        ("eventbridge-problem-deploy", "stack-problem-deploy", "eventbridge", "Amazon EventBridge\n1 分ごとの起動", 220, R1),
        ("lambda-dispatcher", "stack-problem-deploy", "lambda", "AWS Lambda\nDispatcher", 640, R1),
        ("sfn-deploy", "stack-problem-deploy", "step_functions", "AWS Step Functions\nClaim → Create → Describe → Finish\n失敗・タイムアウトを保存", 640, R2),
        ("lambda-recovery", "stack-problem-deploy", "lambda", "AWS Lambda\n失敗した実行の Recovery", 1450, R2),
        ("eventbridge-recovery", "stack-problem-deploy", "eventbridge", "Amazon EventBridge\n失敗・中断・時間切れ", 1090, R2),
        ("lambda-cfn-deploy", "stack-problem-deploy", "lambda", "AWS Lambda\nCloudFormation Worker", 640, R3),
        ("ssm-external-id", "stack-problem-deploy", "systems_manager", "AWS Systems Manager\n共通 ExternalId を保持", 220, R3),
        ("s3-source", "stack-problem-deploy", "s3", "Amazon S3\n固定した hello-world の\nテンプレート・metadata", 640, R4),
        ("s3-competitor-bootstrap", "stack-problem-deploy", "s3", "Amazon S3\n公開 bootstrap テンプレート", 1450, R1),
        ("lambda-participant-access", "stack-problem-deploy", "lambda", "AWS Lambda（同じ API）\n大会・チーム・配置を再検証", 1450, R4),
        ("iam-competitor", "external", "identity_and_access_management", "AWS IAM\n共通 CompetitorDeploy ロール\nExternalId 必須", 2110, R1),
        ("iam-viewer", "external", "identity_and_access_management", "AWS IAM\n配置ごとの ParticipantViewer\nExternalId は Job ID", 2490, R1),
        ("cfn-problem", "competitor-account", "cloudformation", "AWS CloudFormation\nチーム × 問題 × 試行", 2110, R3),
        ("problem-resources", "competitor-account", "systems_manager", "AWS Systems Manager\nhello-world の Parameter", 2110, R4),
        ("participant-cli", "1", "client", "参加者の AWS CLI\n対象 Parameter の読み取りだけ", 2490, 1480),
    ]
    d = Diagram(frames, icons, align_bottoms=("aws-lite", "external"))
    e=d.edge
    e("user-organizer", ("bottom",), "lambda-api", ("top",), "認証済みの配置要求", lab=(0, 0.99))
    e("lambda-api", ("right",), "dynamodb-control", ("left",), "ジョブ・outbox を保存")
    e("eventbridge-problem-deploy", ("right",), "lambda-dispatcher", ("left",), "起動", aux=True)
    e("lambda-dispatcher", ("right",), "dynamodb-control", ("bottom",), "永続キューを確認", via=[(1090, R1)])
    e("lambda-dispatcher", ("bottom",), "sfn-deploy", ("top",), "実行を開始")
    e("sfn-deploy", ("right",), "eventbridge-recovery", ("left",), "失敗した実行の通知", aux=True)
    e("eventbridge-recovery", ("right",), "lambda-recovery", ("left",), "復旧処理", aux=True)
    e("lambda-recovery", ("right",), "dynamodb-control", ("top",), "失敗状態・所有権を照合", aux=True, via=[(1680, R2), (1680, 280), (1090, 280)], lab=(2, 0.5))
    e("sfn-deploy", ("bottom",), "lambda-cfn-deploy", ("top",), "作成・確認・削除")
    e("lambda-cfn-deploy", ("left",), "ssm-external-id", ("right",), "ExternalId を取得")
    e("lambda-cfn-deploy", ("bottom",), "s3-source", ("top",), "artifact hash を検証")
    e("lambda-cfn-deploy", ("right", 0.25), "dynamodb-control", ("right",), "進捗・試行を保存", via=[(1570, R3-15), (1570, R0)], lab=(0, 0.65))
    e("lambda-cfn-deploy", ("right",), "iam-competitor", ("bottom", 0.25), "AssumeRole（ExternalId）", via=[(1810, R3), (1810, 900), (2095, 900)], lab=(0, 0.6))
    e("s3-competitor-bootstrap", ("right",), "iam-competitor", ("left",), "所有者が初期設定（1 回）", aux=True)
    e("iam-competitor", ("bottom", 0.75), "cfn-problem", ("top", 0.75), "CloudFormation API", lab=(0, 0.52))
    e("cfn-problem", ("bottom",), "problem-resources", ("top",), "作成・削除")
    e("user-participants", ("left",), "lambda-participant-access", ("top",), "チームキーで CLI 資格情報を要求", via=[(1800, YU), (1800, 1080), (1450, 1080)], lab=(1, 0.4))
    e("lambda-participant-access", ("right",), "iam-viewer", ("bottom",), "対象配置を確認・AssumeRole", via=[(1770, R4), (1770, 880), (2490, 880)], lab=(2, 0.45))
    e("lambda-participant-access", ("bottom",), "participant-cli", ("left",), "15 分の資格情報（最小権限）", via=[(1450, 1480)], lab=(1, 0.5))
    e("participant-cli", ("top",), "problem-resources", ("right",), "対象 Parameter だけを読む", via=[(2490, R4)])
    return d


def local():
    # 旧 local / local-host を単一 Bun + SQLite に統合。Docker は Challenge を起動するときだけ。
    r0, r1, r2, r3 = 360, 570, 780, 990
    frames = [
        ("local-play", "1", "Local 開催基盤", lane("#F7FCF9", "#2E7B50", 16), 20, 2180, 130),
        ("host", "local-play", "開催者のコンピューター / active Docker context", lane("#FFFFFF", "#405A78", 15, 1), 40, 2160, 190),
        ("tenkacloud-local", "host", "単一の Bun プロセス", CONSOLE_STACK, 80, 1260, 250, 1160),
        ("problem-compose", "host", "所有するチームごとの Docker Compose（ローカル開催のみ）", BACKEND_STACK, 1510, 2120, 510),
    ]
    icons = [
        ("organizer-browser", "1", "user", "開催者のブラウザ\n127.0.0.1:5174", 300, YU),
        ("browser", "1", "client", "参加者のブラウザ\n既定 127.0.0.1:5175", 810, YU),
        ("http", "tenkacloud-local", "traditional_server", "Bun HTTP サーバー\n開催者アカウント・チームキーを分離", 590, r0),
        ("sqlite", "tenkacloud-local", "generic_database", "SQLite\n大会・認証・操作・得点を永続化", 300, r1),
        ("scoring", "tenkacloud-local", "gear", "採点・チェックポイント\n判定と receipt を保存", 1030, r0),
        ("problems", "tenkacloud-local", "documents", "problems/（読み取り専用）\nCompose カタログ・native plugin", 300, r2),
        ("lifecycle", "tenkacloud-local", "gear", "Runtime adapters\n最大 512 個の休止ジョブを準備\n自動 eviction・reset なし", 590, r1),
        ("terminal", "tenkacloud-local", "traditional_server", "認可付き Gateway / Terminal\n稼働中だけ 40 slots を使用", 1030, r1),
        ("runner", "tenkacloud-local", "gear", "Container runner\n同時 team 3 / host 12\n設定 memory cap 合計 4096 MiB", 590, r2),
        ("native-battle", "tenkacloud-local", "gear", "native Cryptography Battle\nBun + SQLite で実行", 1030, r2),
        ("original-keys", "tenkacloud-local", "document", "原本キー・操作記録\n非公開のデータディレクトリ", 300, r3),
        ("docker-sock", "host", "container_2", "Docker daemon\nDocker CLI / Compose", 1380, r2),
        ("problem-container", "problem-compose", "container_1", "問題コンテナ\n参加者の Start / resume で起動", 1810, r1),
        ("retained-data", "problem-compose", "disk", "停止した環境のデータ\n書き込み層・volume を保持\nRAM は破棄・大会の時計は継続", 1810, r3),
    ]
    d=Diagram(frames,icons)
    e=d.edge
    e("organizer-browser", ("bottom",), "http", ("top", 0.25), "開催者認証", via=[(300, 175), (575, 175)], lab=(1, 0.5))
    e("browser", ("bottom",), "http", ("top", 0.75), "大会に属するチームキー", via=[(810, 240), (605, 240)], lab=(1, 0.5))
    e("http", ("left",), "sqlite", ("top",), "認証・大会を読む", via=[(300, r0)])
    e("http", ("right",), "scoring", ("left",), "解答を検証")
    e("http", ("bottom",), "lifecycle", ("top",), "準備・開始・停止")
    e("lifecycle", ("left",), "sqlite", ("right",), "所有権を先に保存")
    e("lifecycle", ("bottom",), "runner", ("top",), "上限を確認・起動/再開")
    e("runner", ("left",), "problems", ("right",), "安全な計画を作る")
    e("runner", ("right",), "docker-sock", ("left",), "Compose 操作", via=[(690, r2), (690, 880), (1380, 880)], lab=(2, 0.5))
    e("docker-sock", ("right",), "problem-container", ("bottom",), "作成・再開・停止", via=[(1810, r2)])
    e("scoring", ("right",), "problem-container", ("top",), "private verifier", via=[(1810, r0)])
    e("browser", ("right",), "terminal", ("top",), "認可された問題の操作", via=[(1190, YU), (1190, 490), (1030, 490)], lab=(0, 0.5))
    e("terminal", ("right",), "problem-container", ("left",), "proxy / exec")
    e("lifecycle", ("right", 0.75), "native-battle", ("top",), "native を初期化", via=[(790, r1+15), (790, 710), (1030, 710)], lab=(2, 0.5))
    e("native-battle", ("bottom",), "sqlite", ("bottom",), "状態・得点を永続化", via=[(1030, 1120), (170, 1120), (170, 680), (300, 680)], lab=(1, 0.5))
    e("sqlite", ("left",), "original-keys", ("left",), "原本を保持", aux=True, via=[(130, r1), (130, r3)], lab=(1, 0.65))
    e("problem-container", ("right",), "retained-data", ("right",), "Stop / make down", via=[(2040, r1), (2040, r3)], lab=(2, 0.5))
    return d


USE_CASE = "rounded=1;arcSize=20;whiteSpace=wrap;html=1;fillColor=#F8FAFC;strokeColor=#405A78;strokeWidth=1.5;fontColor=#16191F;fontSize=12;align=center;verticalAlign=middle"


def use_cases():
    rows = [230 + i * 100 for i in range(10)]
    left = [
        ("uc-event", "大会・チーム・日程を管理する\nlocal / cloud"),
        ("uc-team-key", "大会に属するチームキーを発行・再発行する\nlocal / cloud"),
        ("uc-deploy", "問題を準備・配置・撤去する\nCompose は local / AWS 問題は cloud"),
        ("uc-competitor", "競技用アカウントを登録・検証する\ncloud（開催基盤のアカウントとは分離）"),
        ("uc-notify", "得点を確認し、採点をロック・大会を終了する\nlocal / cloud"),
        ("uc-login", "チームキーで自分の大会に入る\nlocal / cloud"),
        ("uc-play", "自分の環境を Start / resume・Stop (keep data) する\nlocal の on-demand Compose"),
        ("uc-submit", "解答・checkpoint を送り、得点・順位を見る\n現在の対応問題に限る"),
        ("uc-console", "hello-world 用の 15 分 CLI 資格情報を取得する\ncloud（対象 Parameter の読み取りのみ）"),
        ("uc-coordination", "native Cryptography Battle に参加する\nlocal / cloud（基盤に state を永続化）"),
    ]
    right = [
        (0,"uc-commit","問題の定義・検証コードを変更して CI で確認する\nproblems/（TenkaCloudChallenge）"),
        (2,"uc-practice","ローカルの大会を起動・停止する\nmake local / make down（データを保持）"),
        (4,"uc-bootstrap","競技用アカウントの IAM 初期設定を承認する\n共通ロール・必須 ExternalId"),
        (6,"uc-platform","開催基盤を配置・撤去する\nmake deploy / make destroy（対象 installation を確認）"),
        (8,"uc-cleanup","組織の複数アカウントに初期設定を配る\n任意の手動 Organizations / StackSets 手順"),
    ]
    frames=[("tenkacloud","1","TenkaCloud（現行の local / cloud）",lane("#FFFFFF","#232F3E",16),330,2110,130)]
    boxes=[(bid,"tenkacloud",label,780,rows[i],720,70,USE_CASE) for i,(bid,label) in enumerate(left)]
    boxes += [(bid,"tenkacloud",label,1680,rows[i],720,70,USE_CASE) for i,bid,label in right]
    icons=[
        ("actor-organizer","1","user","開催者\n役割に応じた権限",170,rows[2]),
        ("actor-participant","1","users","参加者",170,rows[7]),
        ("actor-author","1","user","問題作成者",2260,rows[0]),
        ("actor-owner","1","user","競技用アカウントの所有者",2260,rows[4]),
        ("actor-operator","1","user","運用者",2260,rows[7]),
    ]
    d=Diagram(frames,icons,boxes)
    for actor,indices in {"actor-organizer":range(5),"actor-participant":range(5,10)}.items():
        for i in indices: d.edge(actor,("right",),left[i][0],("left",),"",straight=True,arrow=False)
    for bid,actor in {"uc-commit":"actor-author","uc-practice":"actor-operator","uc-bootstrap":"actor-owner","uc-platform":"actor-operator","uc-cleanup":"actor-owner"}.items():
        d.edge(actor,("left",),bid,("right",),"",straight=True,arrow=False)
    return d


MODE = "rounded=1;arcSize=12;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#405A78;strokeWidth=1.5;fontColor=#16191F;fontSize=13;align=center;verticalAlign=middle"


def context():
    frames=[
        ("tenkacloud","1","TenkaCloud",lane("#FFFFFF","#232F3E",16),700,1760,200),
        ("aws-account","tenkacloud","AWS 開催基盤アカウント",lane("#FFFFFF","#147EBA",15,1),740,1720,260,760),
        ("pc","tenkacloud","開催者のコンピューター",lane("#FAFBFC","#405A78",15,1),740,1720,800,1240),
        ("competitor-boundary","1","AWS 競技用アカウント（開催基盤から分離）",EXTERNAL,1930,2610,260,720),
    ]
    boxes=[
        ("mode-lite","aws-account","cloud\nLambda / API Gateway / Cognito / DynamoDB\nhello-world・native Cryptography Battle",1230,460,880,100,MODE),
        ("cloud-cli","aws-account","make deploy / make destroy\n現在の cloud CLI・project-scoped CDK bootstrap",1230,650,880,80,MODE),
        ("mode-local-host","pc","local\n単一 Bun プロセス + SQLite\n開催管理・参加者画面・native Cryptography Battle",1230,960,880,100,MODE),
        ("mode-local","pc","on-demand Docker / Compose（local のみ）\nチームごとの起動・停止とディスク状態の保持",1230,1150,880,80,MODE),
    ]
    icons=[
        ("participant","1","users","参加者",200,330),
        ("organizer","1","user","開催者",200,560),
        ("operator","1","user","運用者（AWS 権限）",200,710),
        ("local-operator","1","user","ローカルの開催者",200,1000),
        ("author","1","user","問題作成者",200,1300),
        ("iam-competitor","competitor-boundary","identity_and_access_management","AWS IAM\n共通ロール・ExternalId",2240,370),
        ("competitor","competitor-boundary","cloudformation","AWS CloudFormation\n別アカウント、または\n同一競技用アカウントの別リージョン",2240,580),
        ("challenge","1","documents","problems/（TenkaCloudChallenge）\n固定カタログ・テンプレート・plugin",2240,1150),
    ]
    d=Diagram(frames,icons,boxes)
    e=d.edge
    e("participant",("right",),"tenkacloud",("left",330),"チームキー・問題の操作・得点")
    e("organizer",("right",),"tenkacloud",("left",560),"開催者認証・大会を運営")
    e("operator",("right",),"cloud-cli",("left",),"配置・撤去",via=[(580,710),(580,650)])
    e("local-operator",("right",),"pc",("left",1000),"make local / make down")
    e("aws-account",("right",370),"iam-competitor",("left",),"AssumeRole（ExternalId 必須）")
    e("iam-competitor",("bottom",),"competitor",("top",),"チームの割り当て先へ配置")
    e("challenge",("left",),"mode-local",("right",),"local catalog")
    e("challenge",("top",),"mode-lite",("right",),"cloud の対応 2 問だけを固定",via=[(1840,1060),(1840,460)],lab=(1,0.35))
    e("author",("right",),"challenge",("bottom",),"変更・CI で検証",via=[(2240,1300)],lab=(0,0.5))
    return d


def replace_page(text, page_id, name, model):
    pattern = re.compile(rf'(<diagram id="{page_id}"[^>]*>)(.*?)(</diagram>)', re.S)
    assert len(pattern.findall(text)) == 1, f"{page_id} のページが 1 つだけ見つからない"
    return pattern.sub(lambda m: re.sub(r'name="[^"]*"', f'name="{attr(name)}"', m.group(1)) + "\n        " + model + "\n    " + m.group(3), text)


def build():
    text = SRC.read_text(encoding="utf-8")
    for page_id,name,diagram in [
        ("saas-physical","01 Cloud 開催基盤・AWS 物理構成",cloud()),
        ("lite-physical","02 AWS 問題の実行・信頼境界",aws_exercises()),
        ("local-runtime","03 Local・共通ランタイム",local()),
        ("use-cases","04 現行のユースケース",use_cases()),
        ("system-context","05 現行のシステム境界",context()),
    ]:
        text = replace_page(text,page_id,name,diagram.model())
    OUT.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    build()
