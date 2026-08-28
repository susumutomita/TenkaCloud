# Cognito / SAML IdP 接続プレイブック

Issue #3098。TenkaCloud の管理者画面を企業の SAML 2.0 IdP と接続し、事前疎通、障害切り分け、メタデータ／証明書更新、撤去まで再現可能にするための運用手順。

## 対象とサポート範囲

このプレイブックが対象にするのは **管理者の SSO** であり、Participant Portal の参加者認証ではない。

| 利用者 | 画面 | 認証先 | このプレイブックの対象 |
| --- | --- | --- | --- |
| System Admin | SaaS の Admin Console | Control Plane の Cognito User Pool | 対象 |
| Tenant Admin / Operator / Viewer | Lite または silo tenant の Application Admin Console | 専用 Cognito User Pool | 対象 |
| pooled tenant | Application Admin Console | 共有 Cognito User Pool | tenant 単位 IdP CRUD は対象外 |
| イベント参加者 | Participant Portal | チームログイン鍵 | SAML / Cognito の対象外 |

Application Admin Console の tenant 単位 SAML IdP CRUD は、Lite または **silo tier** の専用 User Pool だけで使う。pooled tier は User Pool を複数 tenant で共有するため、UI と API の両方が fail-closed で拒否する。Cognito コンソールから手動設定してこの境界を迂回しない。

Application Admin Console の `samlSso` は実験的機能で、デフォルトは無効。ID プロバイダ画面が表示されない場合は、対象環境の feature flag と isolation mode を先に確認する。本番導入前に非本番環境で end-to-end の疎通を完了させる。

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

## IdP 登録とログインルーティングは別契約

TenkaCloud の SAML ログインには、次の 3 つがそろう必要がある。

1. Cognito User Pool に SAML IdP が登録されている。
2. Cognito app client の supported identity provider に対象 IdP が含まれている。
3. 通常のログイン画面でメールドメインから IdP を選ぶ場合、`runtime-config.json` の `samlIdpDirectory` に `domain -> provider[]` が入っている。

ID プロバイダ画面の CRUD と、deploy 時に生成される `samlIdpDirectory` は別の投影です。UI で IdP を登録しただけで通常ログインのドメインルーティングまで更新されたと仮定しない。

登録後は次を個別に確認する。

- ID プロバイダ一覧の **Test sign-in** で `identity_provider=<idpId>` を明示し、Cognito と IdP の接続自体を確認する。
- 通常のログイン画面でメールアドレスを入力し、`samlIdpDirectory` に従って同じ IdP へ遷移することを確認する。
- 通常ログインだけ失敗する場合は、deploy 時の SAML 設定と `runtime-config.json` を更新し、管理画面の配信を再デプロイする。

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

## 識別子と権限の考え方

TenkaCloud の federated user は、email ではなく IdP ID と SAML `NameID` を組み合わせて識別する。同一ユーザーの `NameID` が後から変わると、別ユーザーとして扱われる可能性がある。email を `NameID` に使う場合も、変更運用を含めて安定性を確認する。

SAML assertion の group は Cognito の `custom:samlGroups` に写し、`groupToRole` で TenkaCloud role に変換できる。未知の group は権限を付与しない。現行の ID プロバイダ追加画面は `groupToRole` を空で登録するため、まず認証だけを疎通し、role mapping は利用中の管理 API または承認済みの構成経路で別途設定する。

## 接続前チェックリスト

- [ ] 接続対象が Control Plane User Pool か、Lite / silo tenant の User Pool かを決めた。
- [ ] 対象環境で `samlSso` が有効で、ID プロバイダ画面が表示される。
- [ ] TenkaCloud 側で IdP を登録できる TenantAdmin または SystemAdmin がいる。
- [ ] IdP 側で enterprise application / custom SAML application を作成できる管理者がいる。
- [ ] ID プロバイダ追加画面から ACS URL と SP エンティティ ID を控えた。
- [ ] 本番ユーザーとは別のテストユーザーを用意した。
- [ ] テストユーザーの email、NameID、所属 group が想定どおり assertion に入ることを確認できる。
- [ ] IdP 側で対象ユーザーまたは group を application へ割り当てる担当者が決まっている。
- [ ] SAML signing certificate の期限と更新担当者を把握した。
- [ ] SSO が壊れた場合にも使える既存の Cognito local administrator を少なくとも 1 名維持した。
- [ ] IdP と端末の時刻同期が有効である。

## 共通の接続手順

### 1. TenkaCloud 側の SP 情報を取得する

1. 対象の Admin Console に local administrator でサインインする。
2. **ID プロバイダ**を開き、追加を選ぶ。
3. 対象 provider のガイドを選ぶ。AWS IAM Identity Center は **汎用 SAML** として扱う。
4. ACS URL、SP エンティティ ID、email attribute mapping をコピーする。
5. この画面は閉じず、IdP 側の設定を進める。

### 2. IdP 側に TenkaCloud を登録する

IdP 側で次を設定する。

- SAML protocol: SAML 2.0
- Reply URL / ACS URL: TenkaCloud 画面の ACS URL
- Identifier / Audience / エンティティ ID: TenkaCloud 画面の SP エンティティ ID
- NameID: 同じユーザーに対して継続的に同じ値を返す属性
- email claim: TenkaCloud 画面の email attribute mapping と同じ claim 名
- signing: SAML assertion または response を署名する

設定後、IdP metadata XML を取得する。

### 3. TenkaCloud に IdP を登録する

1. `idpId` に変更しない安定した識別子を入力する。例: `corp-entra`、`iam-identity-center`。
2. 運営者に分かる表示名と説明を入力する。
3. IdP metadata XML をファイルでアップロードするか、XML を貼り付ける。
4. email attribute mapping を確認する。
5. 登録する。
6. CloudWatch Logs の構造化イベント `audit.idp` で作成結果を確認する。Audit Log UI へ連携済みの環境では、同じ操作履歴を UI でも確認する。

metadata XML は最大 30 KiB。TenkaCloud は登録前に `EntityDescriptor`、`entityID`、`IDPSSODescriptor`、signing material、`NameIDFormat` を検証し、Cognito が受理できないことが明白な XML を fail-fast で拒否する。

### 4. app client と通常ログインを確認する

1. ID プロバイダ一覧の **Test sign-in** を開く。
2. IdP へ遷移しない場合は、Cognito app client の supported identity provider に対象 `idpId` が含まれるか確認する。
3. Test sign-in が成功したら、通常の Login 画面からメールアドレスを入力する。
4. 期待する IdP へ遷移しない場合は、`runtime-config.json` の `samlIdpDirectory` を確認する。
5. provider ID と `samlIdpDirectory` の値が一致しない場合は、deploy 時の SAML 設定を修正して再デプロイする。

## IdP 別の設定

### Microsoft Entra ID

1. Microsoft Entra admin center で **Enterprise applications** を開く。
2. 新しい enterprise application を作り、SAML single sign-on を選ぶ。
3. Basic SAML Configuration で次を設定する。
   - Identifier (エンティティ ID): TenkaCloud の SP エンティティ ID
   - Reply URL (ACS URL): TenkaCloud の ACS URL
4. Attributes & Claims で、NameID と email claim がテストユーザーの値を返すようにする。
5. Users and groups でテストユーザーまたはテスト group を割り当てる。
6. SAML Certificates から Federation Metadata XML をダウンロードする。
7. XML を TenkaCloud に登録する。

### Google Workspace

1. Google Admin console で **Apps -> Web and mobile apps** を開く。
2. custom SAML application を追加する。
3. Google 側の IdP metadata をダウンロードする。
4. Service provider details に次を設定する。
   - ACS URL: TenkaCloud の ACS URL
   - エンティティ ID: TenkaCloud の SP エンティティ ID
   - Name ID: primary email、または組織で安定性を保証できる識別子
5. email claim が TenkaCloud の email attribute mapping と一致するように属性を設定する。
6. テストユーザーまたは組織部門に application を有効化する。
7. metadata XML を TenkaCloud に登録する。

Google 側の設定反映には時間差が生じる場合があるため、変更直後の 1 回だけで失敗と断定しない。

### AWS IAM Identity Center

1. IAM Identity Center console で **Applications -> Customer managed -> Add application** を開く。
2. setup preference で既存 application を設定する選択肢を選び、application type に **SAML 2.0** を指定する。
3. IAM Identity Center metadata file をダウンロードする。
4. Application metadata は手動入力を選び、次を設定する。
   - Application ACS URL: TenkaCloud の ACS URL
   - Application SAML audience: TenkaCloud の SP エンティティ ID
5. Subject / NameID を安定した値にし、TenkaCloud が要求する email claim を attribute mapping に追加する。
6. テストユーザーまたはテスト group を application へ割り当てる。
7. IAM Identity Center metadata XML を TenkaCloud に登録する。

IAM Identity Center の AWS account / Permission Set 割り当てと、customer managed SAML application の割り当ては別物。TenkaCloud 用 application へのユーザー／group 割り当てを忘れない。

### その他の SAML 2.0 IdP

汎用 SAML ガイドを選び、次を満たす。

- HTTP-POST binding で Cognito ACS URL へ response を送る
- audience が SP エンティティ ID と完全一致する
- `NameID` が存在し、同一ユーザーで安定している
- required attribute、通常は email、が assertion に含まれる
- metadata XML に現在有効な signing certificate が含まれる
- テストユーザーが application へ割り当てられている

## 事前疎通

イベント前日までに、本番と同じ URL から SP-initiated login を確認する。IdP portal の tile から開くだけでは、TenkaCloud の provider routing と callback を検証できない。

1. private browsing window を開く。
2. ID プロバイダ一覧の **Test sign-in** で provider 接続を確認する。
3. TenkaCloud の通常 Login 画面を開く。
4. テストユーザーのメールアドレスから期待する IdP へ遷移することを確認する。
5. IdP でテストユーザーとして認証する。
6. Cognito callback 後に正しい Admin Console へ戻ることを確認する。
7. 画面上の email と tenant が期待どおりであることを確認する。
8. TenantAdmin / Operator / Viewer 等、期待 role の操作だけが許可されることを確認する。
9. サインアウトし、同じユーザーで再度ログインする。
10. 複数 IdP を同じ email domain に登録している場合、IdP 選択画面を確認する。
11. local administrator でも引き続きログインできることを確認する。

## 障害切り分け

| 症状 | 主な原因 | 確認と対処 |
| --- | --- | --- |
| ID プロバイダ画面が見えない | `samlSso` 無効、pooled tenant、権限不足 | feature flag、`isolation`、管理者 role を確認する |
| metadata 登録が `invalid_metadata` | XML が空、30 KiB 超過、必須要素不足 | `entityID`、`IDPSSODescriptor`、signing material、`NameIDFormat` を確認する |
| Test sign-in で IdP へ遷移しない | provider 未登録、app client に未接続、provider ID 不一致 | Cognito User Pool と app client の supported provider を確認する |
| Test sign-in は成功するが通常ログインで遷移しない | `samlIdpDirectory` 未反映、domain / provider ID 不一致 | `runtime-config.json` と deploy 時 SAML 設定を修正し、再デプロイする |
| IdP で「Reply URL 不一致」 | ACS URL の誤り | TenkaCloud 画面から ACS URL を再コピーする。末尾 path を省略しない |
| IdP で「Audience / Identifier 不一致」 | SP エンティティ ID の誤り | TenkaCloud 画面の SP エンティティ ID と完全一致させる |
| Cognito が SAML response を拒否 | metadata 不正、証明書不一致、NameID 不足、時刻ずれ | IdP sign-in log、metadata XML、certificate、NameID、IdP 時刻を確認する |
| ログイン後に別ユーザーが作成される | NameID の値が変わった | NameID source を固定し、既存ユーザーと同じ値を返す |
| ログインは成功するが email が空 | email claim 名と attribute mapping が不一致 | assertion の claim 名と TenkaCloud の email mapping を一致させる |
| ログインは成功するが 403 | group-to-role mapping、tenant、role claim の不一致 | 認証済み email / tenant を確認し、その後 role mapping を確認する |
| 一部ユーザーだけ失敗 | IdP application への割り当て漏れ、属性欠落 | IdP の user / group assignment と対象ユーザーの属性を確認する |
| 全ユーザーが突然失敗 | signing certificate 更新、metadata 内 certificate 期限切れ、IdP 停止 | 最新 metadata を取得し、break-glass admin で TenkaCloud 側を更新する |
| IdP 選択が想定外 | 同一 email domain に複数 provider、directory 不整合 | `samlIdpDirectory` を確認する。複数候補なら選択画面が正常 |

切り分け時は次の順で証跡を集める。

1. ブラウザに表示された error と callback URL の error parameter
2. IdP 側の sign-in / audit log
3. Cognito User Pool の IdP、app client、domain、callback URL 設定
4. TenkaCloud の ID プロバイダ設定と CloudWatch Logs の `audit.idp`
5. ログイン後であれば token の email / tenant / role claim

SAML assertion、ID token、metadata XML には組織情報やユーザー情報が含まれる。Issue や chat へ無加工で貼らず、必要な claim 名と error だけをマスキングして共有する。

## metadata / signing certificate の更新

1. certificate の失効日を運用台帳に登録し、少なくとも 30 日前に更新作業を開始する。
2. IdP 側で新旧 certificate を並行利用できる場合は、重複期間を設ける。
3. 最新 metadata XML を取得する。
4. break-glass administrator で既存 IdP の metadata を更新する。
5. Test sign-in と通常ログインの両方を確認する。
6. 本番ユーザーを 1 名追加して role まで確認する。
7. 旧 certificate の利用終了後に、IdP 側から旧 signing material を削除する。
8. TenkaCloud と IdP 双方の audit log を保存する。

現行の Application Admin Console で edit 操作が表示されない場合でも、backend は `PATCH /tenant/idp/:idpId` で metadata 更新を受け付ける。承認済みの管理 API 経路で更新するか、メンテナンス時間内に再登録する。利用者が残る本番環境で、更新手段を確認せずに IdP を先に削除しない。

TenkaCloud は metadata XML を Cognito の `MetadataFile` として保存する。IdP 側の certificate 更新だけでは自動反映されないため、必ず TenkaCloud 側へ最新 XML を再登録する。

## break-glass と rollback

- SSO の end-to-end 疎通が完了するまで Cognito local administrator を削除しない。
- local auth を無効化する変更は、別の administrator セッションと復旧手順を確保してから行う。
- SAML 設定不備で全員が lock-out した場合は、Cognito User Pool app client に local `COGNITO` provider を復元するか、検証済み構成で `make deploy` を再実行する。
- 復旧後は Test sign-in、通常ログイン、role の順に再確認する。

## IdP の停止・削除

1. 別の有効な administrator 経路があることを確認する。
2. 対象 IdP からテストユーザーの割り当てを外し、想定した fallback または拒否になることを確認する。
3. 対象 IdP を利用している管理者が残っていないことを確認する。
4. TenkaCloud 側で IdP を削除する。
5. `samlIdpDirectory` から provider を外し、runtime config を再デプロイする。
6. ログイン画面の provider routing から消えたことを確認する。
7. 最後に IdP 側の enterprise / custom application を削除する。
8. audit log と変更記録を残す。

TenkaCloud 側を残したまま IdP application を先に削除すると、利用者には選択肢が見えるのに認証できない状態が残る。

## イベント前日の最終確認

- [ ] System Admin または TenantAdmin の SSO が private window で成功する。
- [ ] Test sign-in と通常ログインの両方が成功する。
- [ ] `runtime-config.json` の `samlIdpDirectory` が対象 domain と provider を指す。
- [ ] Operator / Viewer の権限制御を確認した。
- [ ] IdP 側で本番利用 group が TenkaCloud application に割り当てられている。
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
