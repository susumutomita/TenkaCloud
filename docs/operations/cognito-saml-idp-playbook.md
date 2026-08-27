# Cognito / SAML IdP 接続プレイブック

Issue #3098。TenkaCloud の管理者画面を企業の SAML 2.0 IdP と接続し、事前疎通、障害切り分け、メタデータ／証明書更新、撤去まで再現可能にするための運用手順。

## 対象と認証経路

このプレイブックが対象にするのは **管理者の SSO** であり、Participant Portal の参加者認証ではない。

| 利用者 | 画面 | 認証先 | このプレイブックの対象 |
| --- | --- | --- | --- |
| System Admin | SaaS の Admin Console | Control Plane の Cognito User Pool | 対象 |
| Tenant Admin / Operator / Viewer | silo tenant の Application Admin Console | tenant 専用 Cognito User Pool | 対象 |
| pooled tenant | Application Admin Console | pooled の認証構成 | tenant 単位 IdP CRUD は対象外 |
| イベント参加者 | Participant Portal | チームログイン鍵 | SAML / Cognito の対象外 |

Application Admin Console の tenant 単位 SAML IdP CRUD は **silo tier のみ**。ID プロバイダ画面が表示されない環境で、Cognito コンソールから手動設定して UI の制約を迂回しない。

```text
Browser
  -> TenkaCloud login
  -> Cognito Hosted UI / managed login
  -> external SAML IdP
  -> Cognito ACS (/saml2/idpresponse)
  -> Cognito app client callback
  -> TenkaCloud Admin Console
```

- Cognito User Pool が SAML Service Provider (SP)。
- Microsoft Entra ID、Google Workspace、AWS IAM Identity Center 等が Identity Provider (IdP)。
- TenkaCloud は IdP のパスワードを保持しない。
- Participant Portal はチームログイン鍵を bearer として使い、この経路を通らない。

## 正本にする値

IdP 側へ入力する値は、Application Admin Console または Admin Console の **ID プロバイダ追加画面に表示される値をコピーする**。ドキュメント上の例を固定値として使わない。

| 項目 | 用途 |
| --- | --- |
| ACS URL | IdP が SAML Response を POST する Cognito の endpoint。通常は `https://<cognito-domain>/saml2/idpresponse` |
| SP エンティティ ID | SAML audience / identifier。通常は `urn:amazon:cognito:sp:<user-pool-id>` |
| email attribute mapping | SAML assertion の email claim を Cognito の `email` 属性へ写す |
| IdP metadata XML | エンティティ ID、SSO endpoint、signing certificate 等を Cognito に登録する |

画面のデフォルト email claim URI は次の値だが、実際の入力欄を正本とする。

```text
http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress
```

Cognito は少なくとも一貫した `NameID` と、User Pool で必須になっている属性を必要とする。通常は email を必須属性として扱う。

## 接続前チェックリスト

- [ ] 接続対象が Control Plane User Pool か、特定 silo tenant の User Pool かを決めた。
- [ ] TenkaCloud 側で IdP を登録できる TenantAdmin または SystemAdmin がいる。
- [ ] IdP 側で enterprise application / custom SAML application を作成できる管理者がいる。
- [ ] ID プロバイダ追加画面から ACS URL と SP エンティティ ID を控えた。
- [ ] 本番ユーザーとは別のテストユーザーを用意した。
- [ ] テストユーザーの email、NameID、所属グループが想定どおり assertion に入ることを確認できる。
- [ ] IdP 側で対象ユーザーまたはグループをアプリケーションへ割り当てる担当者が決まっている。
- [ ] SAML signing certificate の期限と更新担当者を把握した。
- [ ] SSO が壊れた場合にも使える既存の Cognito local administrator を少なくとも 1 名維持した。
- [ ] IdP と端末の時刻同期が有効である。

## 共通の接続手順

### 1. TenkaCloud 側の SP 情報を取得する

1. 対象の Admin Console に local administrator でサインインする。
2. **ID プロバイダ**を開き、追加を選ぶ。
3. 対象プロバイダのガイドを選ぶ。AWS IAM Identity Center は **汎用 SAML** として扱う。
4. ACS URL、SP エンティティ ID、email attribute mapping をコピーする。
5. この画面は閉じず、IdP 側の設定を進める。

### 2. IdP 側に TenkaCloud を登録する

IdP 側で次を設定する。

- SAML protocol: SAML 2.0
- Reply URL / ACS URL: TenkaCloud 画面の ACS URL
- Identifier / Audience / エンティティ ID: TenkaCloud 画面の SP エンティティ ID
- NameID: 同じユーザーに対して継続的に同じ値を返す属性。原則として email を使う
- email claim: TenkaCloud 画面の email attribute mapping と同じ claim 名
- signing: SAML assertion または response を署名する

設定後、IdP metadata XML を取得する。

### 3. TenkaCloud に IdP を登録する

1. `idpId` に変更しない安定した識別子を入力する。例: `corp-entra`、`iam-identity-center`。
2. 運営者に分かる表示名と説明を入力する。
3. IdP metadata XML をファイルでアップロードするか、XML を貼り付ける。
4. email attribute mapping を確認する。
5. 登録する。
6. 監査ログに IdP 作成操作が記録されたことを確認する。

最初の接続では group-to-role mapping を空のままにし、基本ログインが通ってからロール連携を追加する。認証と認可を同時に変更すると、失敗時の切り分けが難しくなる。

## IdP 別の設定

### Microsoft Entra ID

1. Microsoft Entra admin center で **Enterprise applications** を開く。
2. 新しい enterprise application を作り、SAML single sign-on を選ぶ。
3. Basic SAML Configuration で次を設定する。
   - Identifier (エンティティ ID): TenkaCloud の SP エンティティ ID
   - Reply URL (ACS URL): TenkaCloud の ACS URL
4. Attributes & Claims で、NameID と email claim がテストユーザーの email を返すようにする。
5. Users and groups でテストユーザーまたはテストグループを割り当てる。
6. SAML Certificates から Federation Metadata XML をダウンロードする。
7. XML を TenkaCloud に登録する。

Entra ID の metadata はファイルで取得する運用になるため、signing certificate 更新時は新しい XML を再取得して TenkaCloud 側を更新する。

### Google Workspace

1. Google Admin console で **Apps -> Web and mobile apps** を開く。
2. custom SAML application を追加する。
3. Google 側の IdP metadata をダウンロードする。
4. Service provider details に次を設定する。
   - ACS URL: TenkaCloud の ACS URL
   - エンティティ ID: TenkaCloud の SP エンティティ ID
   - Name ID: primary email
5. email claim が TenkaCloud の email attribute mapping と一致するように属性を設定する。
6. テストユーザーまたは組織部門にアプリを有効化する。
7. metadata XML を TenkaCloud に登録する。

Google 側の設定反映には時間差が生じる場合があるため、変更直後の 1 回だけで失敗と断定しない。

### AWS IAM Identity Center

1. IAM Identity Center console で **Applications -> Customer managed -> Add application** を開く。
2. setup preference で既存アプリケーションを設定する選択肢を選び、application type に **SAML 2.0** を指定する。
3. IAM Identity Center metadata file をダウンロードする。
4. Application metadata は手動入力を選び、次を設定する。
   - Application ACS URL: TenkaCloud の ACS URL
   - Application SAML audience: TenkaCloud の SP エンティティ ID
5. Subject / NameID を安定した email にし、TenkaCloud が要求する email claim を attribute mapping に追加する。
6. テストユーザーまたは、推奨される場合はテストグループをアプリへ割り当てる。
7. IAM Identity Center metadata XML を TenkaCloud に登録する。

IAM Identity Center の AWS アカウント／Permission Set 割り当てと、customer managed SAML application の割り当ては別物。TenkaCloud 用アプリケーションへのユーザー／グループ割り当てを忘れない。

### その他の SAML 2.0 IdP

汎用 SAML ガイドを選び、次を満たす。

- HTTP-POST binding で Cognito ACS URL へ response を送る
- audience が SP エンティティ ID と完全一致する
- `NameID` が存在し、同一ユーザーで安定している
- required attribute、通常は email、が assertion に含まれる
- metadata XML に現在有効な signing certificate が含まれる
- テストユーザーがアプリケーションへ割り当てられている

## 事前疎通

イベント前日までに、本番と同じ URL から SP-initiated login を確認する。IdP portal のタイルから開くだけでは、TenkaCloud の provider routing と callback を検証できない。

1. private browsing window を開く。
2. TenkaCloud の Admin Console URL を開く。
3. SSO を開始する。
4. IdP でテストユーザーとして認証する。
5. Cognito callback 後に正しい Admin Console へ戻ることを確認する。
6. 画面上の email と tenant が期待どおりであることを確認する。
7. TenantAdmin / Operator / Viewer 等、期待ロールの操作だけが許可されることを確認する。
8. サインアウトし、同じユーザーで再度ログインする。
9. 複数 IdP を同じ環境に登録している場合、email domain に応じた redirect または IdP 選択画面を確認する。
10. local administrator でも引き続きログインできることを確認する。

## 障害切り分け

| 症状 | 主な原因 | 確認と対処 |
| --- | --- | --- |
| IdP へ遷移しない | IdP 未登録、対象環境違い、provider routing 未反映 | 接続対象 User Pool、runtime config、ID プロバイダ一覧を確認する |
| IdP で「Reply URL 不一致」 | ACS URL の誤り | TenkaCloud 画面から ACS URL を再コピーする。末尾 path を省略しない |
| IdP で「Audience / Identifier 不一致」 | SP エンティティ ID の誤り | TenkaCloud 画面の SP エンティティ ID と完全一致させる |
| Cognito が SAML response を拒否 | metadata 不正、署名証明書不一致、NameID 不足、時刻ずれ | IdP sign-in log、metadata XML、certificate、NameID、端末／IdP 時刻を確認する |
| ログイン後に別ユーザーが作成される | NameID の表記または大小文字が変わった | NameID source を固定し、既存ユーザーと同じ値を返す |
| ログインは成功するが email が空 | email claim 名と attribute mapping が不一致 | assertion の claim 名と TenkaCloud の email mapping を一致させる |
| ログインは成功するが 403 | group-to-role mapping、tenant、role claim の不一致 | まず認証済み email / tenant を確認し、その後 role mapping を確認する |
| 一部ユーザーだけ失敗 | IdP application への割り当て漏れ、属性欠落 | IdP の user/group assignment と対象ユーザーの属性を確認する |
| 全ユーザーが突然失敗 | signing certificate 更新、metadata 内の signing certificate 期限切れ、IdP 停止 | 新 metadata を取得し、break-glass admin で TenkaCloud 側を更新する |
| IdP 選択が想定外 | 同一 email domain に複数 provider、directory 不整合 | 接続済み provider と domain routing を確認する。候補が複数なら選択画面が正常 |

切り分け時は次の順で証跡を集める。

1. ブラウザに表示された error と callback URL の error parameter
2. IdP 側の sign-in / audit log
3. Cognito User Pool の IdP、app client、domain、callback URL 設定
4. TenkaCloud の ID プロバイダ設定と監査ログ
5. ログイン後であれば token の email / tenant / role claim

SAML assertion、ID token、metadata XML には組織情報やユーザー情報が含まれる。Issue やチャットへ無加工で貼らず、必要な claim 名とエラーだけをマスキングして共有する。

## metadata / signing certificate の更新

1. certificate の失効日を運用台帳に登録し、少なくとも 30 日前に更新作業を開始する。
2. IdP 側で新旧 certificate を並行利用できる場合は、重複期間を設ける。
3. 最新 metadata XML を取得する。
4. break-glass administrator で TenkaCloud の既存 IdP を更新する。新規 `idpId` を作って無計画に切り替えない。
5. テストユーザーで SP-initiated login を確認する。
6. 本番ユーザーを 1 名追加して確認する。
7. 旧 certificate の利用終了後に、IdP 側から旧 signing material を削除する。
8. TenkaCloud と IdP 双方の監査ログを保存する。

metadata URL を使わず XML を保存する IdP では、IdP 側の certificate 更新だけでは Cognito に自動反映されない。必ず TenkaCloud 側へ最新 XML を再登録する。

## IdP の停止・削除

1. 別の有効な administrator 経路があることを確認する。
2. 対象 IdP からテストユーザーの割り当てを外し、想定した fallback または拒否になることを確認する。
3. 対象 IdP を利用している管理者が残っていないことを確認する。
4. TenkaCloud 側で IdP を削除する。
5. ログイン画面の provider routing から消えたことを確認する。
6. 最後に IdP 側の enterprise / custom application を削除する。
7. 監査ログと変更記録を残す。

TenkaCloud 側を残したまま IdP application を先に削除すると、利用者には選択肢が見えるのに認証できない状態が残る。

## イベント前日の最終確認

- [ ] System Admin または TenantAdmin の SSO が private window で成功する。
- [ ] Operator / Viewer の権限制御を確認した。
- [ ] IdP 側で本番利用グループが TenkaCloud application に割り当てられている。
- [ ] ACS URL、SP エンティティ ID、metadata XML の対象環境を再確認した。
- [ ] certificate の有効期限がイベント終了後まで十分に残っている。
- [ ] break-glass administrator でログインできる。
- [ ] Participant Portal の参加者ログイン鍵は別経路で配布することを運営メンバーが理解している。
- [ ] 障害時に確認する IdP log、Cognito User Pool、TenkaCloud audit log の担当者を決めた。

## 公式リファレンス

- [Using SAML identity providers with a user pool](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp.html)
- [Things to know about SAML IdPs in Amazon Cognito user pools](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-saml-idp-things-to-know.html)
- [Set up your own SAML 2.0 application in IAM Identity Center](https://docs.aws.amazon.com/singlesignon/latest/userguide/customermanagedapps-set-up-your-own-app-saml2.html)
- [Microsoft Entra: troubleshoot SAML-based single sign-on](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/troubleshoot-saml-based-sso)
