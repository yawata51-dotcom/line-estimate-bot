import express, { Request, Response } from 'express';
import { messagingApi, middleware, webhook } from '@line/bot-sdk';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

// ── 環境変数チェック ──────────────────────────────────────────
const {
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  ANTHROPIC_API_KEY,
  GAS_API_URL,
  PORT = '3000',
} = process.env;

if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN || !ANTHROPIC_API_KEY) {
  console.error('❌ 必要な環境変数が設定されていません。.env ファイルを確認してください。');
  process.exit(1);
}

// ── 登録フロー メッセージ設定（ここを編集してカスタマイズ） ──
const REGISTRATION_MESSAGES = {
  // 稲毛クイズ応募への自動返信
  quizReply:
    'ご応募ありがとうございます！🎉\n\n抽選対象として承りました。\n正解者の中から抽選で5名様にQUOカード500円分をプレゼントいたします🎁\n\n当選された方には後日このLINEよりご連絡いたします。\n引き続きヤハタデンキをよろしくお願いいたします😊',

  // 未登録ユーザーが最初にメッセージを送ってきた時
  askPhone: 'はじめまして！ヤハタデンキ公式LINEです😊\n\nご登録のため、お電話番号をご入力ください。\n（例：090-1234-5678）',

  // 電話番号で顧客マスタに見つかった時
  registeredSuccess: (name: string) =>
    `${name} 様、登録が完了しました✅\n\nこれからは工事の写真をお送りいただくと、概算見積もりをすぐにご返信します📸`,

  // 電話番号が顧客マスタに見つからなかった時
  notFound: '電話番号が見つかりませんでした。\n番号を確認して再度ご入力いただくか、お電話（📞）でお問い合わせください。',

  // 電話番号の形式が正しくない時
  invalidPhone: '電話番号の形式が正しくありません。\n数字のみ、またはハイフン付きで入力してください。\n（例：090-1234-5678）',

  // GAS API が使えない場合（GAS_API_URL未設定）
  gasNotConfigured: '現在登録システムに接続できません。お手数ですが、お電話でお問い合わせください。',

  // 登録済みユーザーがテキストを送ってきた時（写真を促す）
  sendPhoto: '写真を送っていただくと、概算見積もりをお答えします📸',
};

// ── クライアント初期化 ────────────────────────────────────────
const lineConfig = {
  channelSecret: LINE_CHANNEL_SECRET,
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
};

const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── 登録フロー状態管理（メモリ） ─────────────────────────────
// サーバー再起動でリセットされる。永続化が必要なら Redis 等に移行。
const userState = new Map<string, 'waiting_phone'>();
const registeredUsers = new Set<string>();

// ── Claude へ渡すプロンプト ───────────────────────────────────
const PRICE_TABLE = `【料金表】
■ コンセント・スイッチ工事
　出張費：2,750円（稲毛区内）
　工事費：4,400円〜11,000円（1ヶ所）
　合計：7,150円〜13,750円

■ エアコン本体価格
　LVシリーズ（最上位）：431,300円〜
　XSシリーズ（省エネタイプ）：311,000円〜
　EXシリーズ（掃除ロボ付）：177,000円〜
　Jシリーズ（スタンダード）：120,000円〜
　Fシリーズ（エントリー）：113,000円〜

■ 分電盤交換工事
　施工費：26,400円〜（12回路まで、以降2回路増えるごとに4,400円追加）
　【スタンダード分電盤】本体：46,200円〜165,000円（税込）
　【地震あんしんばん】本体：74,140円〜155,650円（税込）
　※施工費は回路数が同じであればどちらも同額

■ エアコン工事費（4〜6月）
　交換：38,390円〜
　新規：39,600円〜

■ エアコン工事費（1〜3月）
　交換：28,490円〜
　新規：29,700円〜

■ エアコン工事費（7〜12月）
　交換：48,290円〜
　新規：49,500円〜`;

function buildPrompt(): string {
  const month = new Date().getMonth() + 1;
  return `現在の月は${month}月です。

${PRICE_TABLE}

この画像を見て、上記料金表の中で最も可能性が高い工事を判断し、以下のルールで回答してください。他の説明は一切不要です。

【エアコン工事の場合】
現在の月から該当する季節の工事費を使い、交換か新規かを画像から判断する。以下の形式で回答：
【工事内容】（工事名と作業内容を1〜2行で）
【本体価格】LVシリーズ 431,300円〜 / XSシリーズ 311,000円〜 / EXシリーズ 177,000円〜 / Jシリーズ 120,000円〜 / Fシリーズ 113,000円〜
【工事費】〇〇円〜
【合計概算】〇〇円〜
※現地確認後に正式お見積もりをお送りします。このLINEでお気軽にご連絡ください💬

【分電盤交換工事の場合】
スタンダードと地震あんしんばんの2プランを並べて提案する。以下の形式で回答：
【工事内容】分電盤交換工事（作業内容を1〜2行で）
【工事費】26,400円〜（12回路まで）
▼プランA スタンダード分電盤
【本体価格】46,200円〜
【合計概算】〇〇円〜
▼プランB 地震あんしんばん
【本体価格】74,140円〜
【合計概算】〇〇円〜
※現地確認後に正式お見積もりをお送りします。このLINEでお気軽にご連絡ください💬

【コンセント・スイッチ工事の場合】
以下の形式で回答：
【工事内容】（工事名と作業内容を1〜2行で）
【出張費】2,750円（稲毛区内）
【工事費】4,400円〜11,000円
【合計概算】7,150円〜13,750円
※現地確認後に正式お見積もりをお送りします。このLINEでお気軽にご連絡ください💬

【その他工事の場合】
以下の形式で回答：
【工事内容】（工事名と作業内容を1〜2行で）
【概算費用】〇〇円〜〇〇円
※現地確認後に正式お見積もりをお送りします。このLINEでお気軽にご連絡ください💬`;
}

// ── LINE から画像を直接ダウンロード ──────────────────────────
async function downloadLineImage(messageId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } },
  );

  if (!res.ok) {
    throw new Error(`LINE image download failed: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') ?? 'image/jpeg';
  const mimeType = contentType.split(';')[0].trim();
  const buffer = Buffer.from(await res.arrayBuffer());

  if (buffer.length === 0) {
    throw new Error('ダウンロードした画像データが空です');
  }

  return { buffer, mimeType };
}

// ── 画像分析処理 ──────────────────────────────────────────────
const MAX_LINE_TEXT_LENGTH = 4500;

const VALID_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type ImageMediaType = typeof VALID_MEDIA_TYPES[number];

async function analyzeImage(messageId: string): Promise<string> {
  const { buffer: imageBuffer, mimeType } = await downloadLineImage(messageId);

  console.log(`📸 画像サイズ: ${imageBuffer.length} bytes, MIME: ${mimeType}`);

  const mediaType: ImageMediaType = VALID_MEDIA_TYPES.includes(mimeType as ImageMediaType)
    ? (mimeType as ImageMediaType)
    : 'image/jpeg';

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: imageBuffer.toString('base64'),
            },
          },
          {
            type: 'text',
            text: buildPrompt(),
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find(block => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude からテキスト応答が返りませんでした');
  }

  let text = textBlock.text;
  if (text.length > MAX_LINE_TEXT_LENGTH) {
    text = text.slice(0, MAX_LINE_TEXT_LENGTH) + '\n\n（文字数制限のため省略）';
  }
  return text;
}

// ── GAS API で電話番号照合・LINE user ID 登録 ─────────────────
async function registerByPhone(tel: string, lineUserId: string): Promise<{ success: boolean; name?: string; msg?: string }> {
  if (!GAS_API_URL) {
    return { success: false, msg: 'gas_not_configured' };
  }

  const url = `${GAS_API_URL}?action=register&tel=${encodeURIComponent(tel)}&lineUserId=${encodeURIComponent(lineUserId)}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`GAS API error: ${res.status}`);
  }

  return res.json() as Promise<{ success: boolean; name?: string; msg?: string }>;
}

// ── 電話番号らしい文字列かチェック ───────────────────────────
function looksLikePhone(text: string): boolean {
  const digits = text.replace(/[^\d]/g, '');
  return digits.length >= 10 && digits.length <= 11;
}

// ── Webhook イベントハンドラ ──────────────────────────────────
async function handleEvent(event: webhook.Event): Promise<void> {
  if (event.type !== 'message' || !event.replyToken) return;

  const { replyToken, message } = event;
  const userId = (event as webhook.MessageEvent & { source: { userId?: string } }).source?.userId;

  // ── 画像メッセージ ────────────────────────────────────────
  if (message.type === 'image') {
    // 未登録でも画像は処理する（登録なしで使えるようにする）
    try {
      console.log(`📩 画像受信 messageId=${message.id}`);
      const estimateText = await analyzeImage(message.id);

      await lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: estimateText }],
      });

      console.log('✅ 見積もり送信完了');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('❌ 画像処理エラー:', msg, error);
      await lineClient.replyMessage({
        replyToken,
        messages: [
          {
            type: 'text',
            text: '⚠️ 処理中にエラーが発生しました。しばらく時間をおいて再度お試しください。',
          },
        ],
      });
    }
    return;
  }

  // ── テキストメッセージ ────────────────────────────────────
  if (message.type !== 'text') return;

  const text = message.text.trim();

  if (!userId) return;

  // クイズ応募キーワードのみ返信、それ以外のテキストは無視
  const quizPattern = /[①②③]|^[123]$|飛行場|遊園地|温泉/;
  if (quizPattern.test(text)) {
    await lineClient.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: REGISTRATION_MESSAGES.quizReply }],
    });
  }
}

// ── Express サーバー ──────────────────────────────────────────
const app = express();

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post(
  '/webhook',
  middleware(lineConfig),
  async (req: Request, res: Response): Promise<void> => {
    const events: webhook.Event[] = req.body.events;

    try {
      await Promise.all(events.map(handleEvent));
      res.json({ status: 'ok' });
    } catch (err) {
      console.error('Webhook エラー:', err);
      res.status(500).json({ status: 'error' });
    }
  },
);

const port = parseInt(PORT, 10);
app.listen(port, () => {
  console.log(`🚀 LINE Webhook サーバー起動 → http://localhost:${port}`);
  console.log(`   Webhook URL: http://localhost:${port}/webhook`);
  console.log(`   ヘルスチェック: http://localhost:${port}/health`);
});
