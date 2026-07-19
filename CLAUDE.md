# ヤハタ電機商会 LINE見積ボット 引き継ぎ情報

## プロジェクト概要
ヤハタ電機商会（千葉市）の公式LINEアカウントに、写真を送ると自動でエアコン・照明・電気工事の見積もりを返信するボットを構築中。

---

## 現在の構成

| 項目 | 内容 |
|------|------|
| 言語 | Node.js |
| ホスティング | Render（無料プラン） |
| LINEアカウント | ヤハタデンキ 公式LINE |
| GitHubリポジトリ | `https://github.com/yawata51-dotcom/line-estimate-bot` |
| Webhook URL | `https://line-estimate-bot.onrender.com/webhook` |

---

## 更新履歴（2026-07-19）
- **料金表をスプレッドシート連動に変更**：商品見積システムのスプレッドシート内「LINEボット料金表」シート（A列）を10分キャッシュで取得。シートを編集すれば最大10分でボットに反映。取得失敗時はコード内のフォールバック表を使用
- **プロンプト改善**：判断に迷う写真には確認質問を1つ添える／工事と無関係な写真には見積を出さない
- **モデル更新**：claude-opus-4-7 → claude-opus-4-8
- デプロイ：git push → Render自動デプロイ
- ⚠️ GitHub PAT「line-estimate-bot」が2026-07-26頃期限切れ → 以降このPCからpushする際は新PAT作成が必要

## 現在の状態（2026年4月時点）

### ✅ 完了済み
- LINE Developers プロバイダー作成（ヤハタデンキ）
- LINE Official Account Manager で Messaging API 有効化
- Webhook URL 設定済み・Webhook利用オン
- Render へのデプロイ完了
- GitHub リポジトリ作成・プッシュ済み（`.env` は gitignore 済み）
- LINEから写真を送ると**ボットが反応する**ことを確認済み

### ❌ 未解決の問題
- Render 無料プランのため **15分無通信でサーバーが休止**する
  - → 1通目のメッセージが届かないことがある
  - → UptimeRobot（無料）で定期アクセスさせるか、有料プラン（$7/月）へ移行で解決可能

---

## 環境変数（.env）

以下の3つが必要。Render の Environment に設定する。

```
LINE_CHANNEL_SECRET=（LINE Developers > チャネル基本設定 > Channel secret）
LINE_CHANNEL_ACCESS_TOKEN=（LINE Developers > Messaging API設定 > チャンネルアクセストークン）
ANTHROPIC_API_KEY=（Anthropic Console で取得）
```

---

## 重要URL

| サービス | URL |
|---------|-----|
| LINE Developers | https://developers.line.biz/console/ |
| LINE Official Account Manager | https://manager.line.biz |
| Render ダッシュボード | https://dashboard.render.com |
| GitHub リポジトリ | https://github.com/yawata51-dotcom/line-estimate-bot |

---

## 次にやること（優先順）

1. **サーバー休止問題を解決する**
   - UptimeRobot で5分おきに自動アクセス設定、または Render 有料プラン（$7/月）へ移行

2. **見積もり返信の内容を改善する**
   - エアコン・照明・電気工事の料金表をボットに読み込ませる
   - 返信メッセージのフォーマットを整える

---

## このファイルについて
Claude Code で作業を再開するときは、最初に「CLAUDE.mdを読んで現状を確認して」と伝えてください。
