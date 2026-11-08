# Thread Expander

Slackのスレッドに新しい返信が投稿されると、元のチャンネルのタイムラインへBotが転送します。Cloudflare Workers、Queues、D1で動作する、単一ワークスペース向けのアプリです。

転送先は、返信が投稿されたのと同じチャンネルです。Block Kitの `context` に返信本文の先頭30文字を表示し、続く `section` に `スレッドに返信済み: <スレッド先頭メッセージの先頭20文字>` を返信へのリンクとして表示します。

```text
Slack Events API → Worker（署名検証・対象判定）→ Queue
                                               ↓
                         D1で重複確認 → Slackへ投稿
                                               ↓ 失敗時は再試行
                                             DLQ
```

## 転送する内容

- `SOURCE_CHANNEL_IDS` に指定した公開・非公開チャンネルの、新しいスレッド返信を対象にします。対象チャンネルにはBotを参加させてください。
- 通常のチャンネル投稿、Botやアプリの投稿、編集・削除、DMは除外します。
- Slackの「チャンネルにも送信」で共有済みの返信も除外します。
- 返信の `text` を使い、先頭30文字を平文で表示します。
- 本文がない画像・ファイルのみの返信では、本文の表示名に `元のメッセージ` を使います。
- 受信した `blocks` はそのまま再投稿せず、アプリ側で組み立てた `context` と `section` を使います。添付ファイル、画像、ファイルカードは投稿しません。

## Slack Appの作成

1. [Slack Apps](https://api.slack.com/apps)で **Create New App → From a manifest** を選び、対象のワークスペースを指定します。
2. [slack-app-manifest.json](./slack-app-manifest.json)をJSON形式で貼り付け、Appを作成します。Request URLはWorkerのデプロイ後に設定します。
3. **Install App** からワークスペースにインストールします。**OAuth & Permissions** の **Bot User OAuth Token**（`xoxb-...`）を控えます。
4. **Basic Information → App Credentials** の **Signing Secret** を控えます。

マニフェストでは次の権限とBotイベントを指定しています。権限を変更したときはAppを再インストールしてください。

| 設定                                    | 用途                         |
| --------------------------------------- | ---------------------------- |
| `chat:write`                            | 転送メッセージを投稿         |
| `channels:history` / `message.channels` | 公開チャンネルの投稿を受信   |
| `groups:history` / `message.groups`     | 非公開チャンネルの投稿を受信 |

公開チャンネルだけを対象にする場合は、`groups:history` と `message.groups` をマニフェストから削除できます。

## Cloudflareへのデプロイ

Node.js 24（[.node-version](./.node-version)）とpnpmを用意し、CloudflareアカウントでWorkers、Queues、D1を利用できる状態にします。

```sh
pnpm install
cp wrangler.jsonc wrangler.local.jsonc
pnpm exec wrangler login
pnpm exec wrangler d1 create thread-expander --config wrangler.local.jsonc
```

Git管理する [wrangler.jsonc](./wrangler.jsonc) は共通設定のテンプレートです。コピーした `wrangler.local.jsonc` はGit管理外で、`pnpm dev`、`pnpm run deploy`、`pnpm db:local`、`pnpm db:remote` が使用します。

コマンドが返す `database_id` を `wrangler.local.jsonc` の `DB` バインディングのゼロ埋めIDと置き換え、`vars` も設定します。既存のデータベースを使う場合は、そのIDを指定します。DBとキューは利用者自身のCloudflareアカウントに作成してください。

| 変数                 | 設定値                                                                            |
| -------------------- | --------------------------------------------------------------------------------- |
| `SLACK_TEAM_ID`      | 必須。対象ワークスペースのID（`T...`）                                            |
| `SOURCE_CHANNEL_IDS` | 対象のチャンネルIDをカンマ区切りで指定（例：`C123,G456`）。空文字なら転送しません |

ワークスペースIDとチャンネルIDは、Slackブラウザ版の `https://app.slack.com/client/T.../C...` などから確認できます。チャンネル名ではなくIDを指定します。

続いてキューとテーブルを作成し、Workerをデプロイします。

```sh
pnpm exec wrangler queues create thread-expander --config wrangler.local.jsonc
pnpm exec wrangler queues create thread-expander-dlq --config wrangler.local.jsonc
pnpm db:remote
pnpm cf-typegen
pnpm check
pnpm run deploy
```

Slackの認証情報は、次のコマンドが表示する入力欄へそれぞれ入力します。

```sh
pnpm exec wrangler secret put SLACK_SIGNING_SECRET --config wrangler.local.jsonc
pnpm exec wrangler secret put SLACK_BOT_TOKEN --config wrangler.local.jsonc
```

トークンやSigning Secretは設定ファイルに書かず、Wrangler Secretsで管理します。`pnpm cf-typegen` とCIは、共通設定の `wrangler.jsonc` を使用します。

## GitHub ActionsでのCI

[CIワークフロー](./.github/workflows/ci.yml)は、Pull Request、`main` へのpush、手動実行で起動します。Node.jsのバージョンは `.node-version`、pnpmのバージョンは `package.json` の `packageManager` に合わせます。

ロックファイルに従って依存関係をインストールし、Workerの生成型の整合性、lint、整形、型チェック、テストを確認します。CIにGitHub SecretsやCloudflareの認証情報は必要ありません。

`main` のブランチ保護では `Check` を必須チェックに指定できます。Actionsの `uses` はバージョンタグで記述し、コミットへの固定は `gh actions-lock` で管理します。DependabotはActionsの更新を週次で確認します。

## Slackとの接続と動作確認

1. Slack Appの **Event Subscriptions** を有効にし、**Request URL** に `https://<デプロイしたWorkerのホスト名>/slack/events` を設定します。署名を検証したうえでURL確認のchallengeに応答します。
2. **Subscribe to bot events** に `message.channels` と `message.groups` があることを確認し、**Save Changes** を押します。
3. `SOURCE_CHANNEL_IDS` に指定した各チャンネルで `/invite @Thread Expander` を実行し、Botを参加させます。
4. チャンネルに親メッセージを投稿し、そのスレッドに返信します。返信がチャンネルのタイムラインへ別のBotメッセージとして表示されれば接続完了です。

`GET /health` はWorkerの稼働確認用です。Slackの権限やデータベースの疎通までは検証しません。

## ローカル開発とテスト

```sh
cp .dev.vars.example .dev.vars
# .dev.vars に開発用のSigning SecretとBot Tokenを設定
# wrangler.local.jsonc の SLACK_TEAM_ID と SOURCE_CHANNEL_IDS も設定
pnpm db:local
pnpm dev
```

Slackからローカル環境にイベントを送るには、HTTPSトンネルなどで `http://localhost:8787/slack/events` を公開し、開発用AppのRequest URLに設定します。ローカル開発でも実際のSlackへ投稿するため、開発用チャンネルを `SOURCE_CHANNEL_IDS` に指定します。

テストはWorkersランタイムで実行し、D1には実際のマイグレーションを適用します。Slackへの通信はモックしています。

```sh
pnpm cf-typegen
pnpm check
pnpm run deploy --dry-run
```

署名の改ざん・期限切れ、URL確認、イベントの選別、キュー投入の失敗、並行配信の重複抑止、期限切れロックからの復旧、Slackエラーと `Retry-After`、送信済みIDの削除を検証します。

## 再試行と運用

Slackの署名を検証したWorkerは、キューへの保存が成功してからHTTP 200を返します。キュー投入が失敗したときは503を返し、Slack側の再送を受け付けます。転送処理はQueue consumerが担当します。

D1では元のワークスペースID・チャンネルID・返信のタイムスタンプをキーにして、通常の再送や並行処理による二重投稿を抑えます。処理中のロックは120秒で失効し、処理が中断した場合も再試行できます。送信済みIDは30日間保持し、毎日UTC 03:00に古いIDを削除します。

Slack APIの失敗は再試行し、レート制限時は `Retry-After` に従います。10回の再試行を使い切ったメッセージは `thread-expander-dlq` に移ります。CloudflareダッシュボードのQueuesでDLQと失敗件数を確認し、原因を修正してから対象メッセージを元のキューへ再投入してください。DLQには返信本文を含む転送データが保存されます。

```sh
pnpm exec wrangler tail --config wrangler.local.jsonc
```

ログの `forward_failed` にはイベントID、再試行回数、エラーコードを出力します。`not_in_channel` はBotの参加状況、`missing_scope` はAppの権限と再インストール、`invalid_auth` はBot Tokenを確認します。本文と認証情報はアプリのログに出力しません。

### 制約

- Slackへの投稿成功直後に通信が切れた場合や、D1への完了記録に失敗した場合は、再試行で二重投稿される可能性があります。Slackへの投稿とD1の更新を単一トランザクションにできないため、厳密な「必ず一度だけ」の転送は保証しません。
- Queuesの配信順序は保証されません。再試行中に後続の返信が先に転送されることがあります。
- 有効化後に受信した新規返信を対象とします。過去のスレッドの一括転送や、転送後の編集・削除の同期は行いません。
- 1つのSlackワークスペースに対応します。複数ワークスペースへの配布にはOAuthとワークスペースごとのトークン管理が必要です。

## 公式ドキュメント

- [Slack Events API](https://docs.slack.dev/apis/events-api/)
- [Slackリクエストの署名検証](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [Cloudflare Queuesの再試行](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Cloudflare Workersのテスト](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)
