import express, { Request, Response } from 'express';
import { messagingApi, middleware, webhook } from '@line/bot-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

// ── 環境変数チェック ──────────────────────────────────────────
const {
  LINE_CHANNEL_SECRET,
  LINE_CHANNEL_ACCESS_TOKEN,
  GEMINI_API_KEY,
  PORT = '3000',
} = process.env;

if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN || !GEMINI_API_KEY) {
  console.error('❌ 必要な環境変数が設定されていません。.env ファイルを確認してください。');
  process.exit(1);
}

// ── クライアント初期化 ────────────────────────────────────────
const lineConfig = {
  channelSecret: LINE_CHANNEL_SECRET,
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
};

const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

const gemini = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = gemini.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

// ── Gemini へ渡すプロンプト ───────────────────────────────────
const ESTIMATE_PROMPT = `この画像を分析して、エアコン設置・照明工事・電気工事の観点からプロの電気工事業者として見積もりを提供してください。

【回答形式（必ずこの形式で回答してください）】

📊 現場状況の分析
（画像から読み取れる部屋の種類・広さ・既存設備・工事難易度を具体的に説明）

💰 工事内容と概算見積もり

🌡️ エアコン設置工事（画像に関連する場合）
・工事内容：（機種選定・配管・電気工事など具体的な作業内容）
・概算費用：〇〇,000円〜〇〇〇,000円（機器代別）
・備考：（注意点・オプション作業など）

💡 照明工事（画像に関連する場合）
・工事内容：（器具の種類・取付方法・配線など具体的な作業内容）
・概算費用：〇〇,000円〜〇〇〇,000円
・備考：（注意点など）

⚡ その他電気工事（画像に関連する場合）
・工事内容：（コンセント増設・分電盤工事・配線など具体的な作業内容）
・概算費用：〇〇,000円〜〇〇〇,000円
・備考：（注意点など）

📝 合計概算：〇〇〇,000円〜〇〇〇,000円

⚠️ 注意事項
・上記は写真からの概算であり、正確な金額は現地調査が必要です
・築年数・配線状況・建物構造により費用が変動します
・すべての電気工事は電気工事士が施工します`;

// ── LINE から画像を直接ダウンロード ──────────────────────────
// SDK の stream 変換を介さず fetch + arrayBuffer() で取得する
async function downloadLineImage(messageId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } },
  );

  if (!res.ok) {
    throw new Error(`LINE image download failed: ${res.status} ${res.statusText}`);
  }

  // Content-Type ヘッダーからMIMEタイプを取得（フォールバック: image/jpeg）
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

async function analyzeImage(messageId: string): Promise<string> {
  const { buffer: imageBuffer, mimeType } = await downloadLineImage(messageId);

  console.log(`📸 画像サイズ: ${imageBuffer.length} bytes, MIME: ${mimeType}`);

  const result = await geminiModel.generateContent([
    { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
    { text: ESTIMATE_PROMPT },
  ]);

  const candidate = result.response.candidates?.[0];
  if (!candidate) {
    throw new Error('Gemini からの応答にcandidateがありません');
  }

  if (candidate.finishReason === 'SAFETY') {
    return '⚠️ 画像の内容を分析できませんでした。別の写真をお試しください。';
  }

  if (candidate.finishReason && candidate.finishReason !== 'STOP') {
    console.warn(`⚠️ Gemini finishReason: ${candidate.finishReason}`);
  }

  let text = result.response.text();
  if (text.length > MAX_LINE_TEXT_LENGTH) {
    text = text.slice(0, MAX_LINE_TEXT_LENGTH) + '\n\n（文字数制限のため省略）';
  }
  return text;
}

// ── Webhook イベントハンドラ ──────────────────────────────────
async function handleEvent(event: webhook.Event): Promise<void> {
  if (event.type !== 'message' || !event.replyToken) return;

  const { replyToken, message } = event;

  if (message.type !== 'image') {
    await lineClient.replyMessage({
      replyToken,
      messages: [
        {
          type: 'text',
          text: '📷 現場の写真を送ってください。\nエアコン設置・照明工事・電気工事の概算見積もりをAIが分析してお伝えします。',
        },
      ],
    });
    return;
  }

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
