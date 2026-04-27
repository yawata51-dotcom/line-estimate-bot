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
const geminiModel = gemini.getGenerativeModel({ model: 'gemini-2.5-flash' });

// ── Gemini へ渡すプロンプト ───────────────────────────────────
const ESTIMATE_PROMPT = `この画像を見て、エアコン設置・照明工事・電気工事の中で最も可能性が高い工事を1つだけ選び、以下の形式だけで回答してください。他の説明は一切不要です。

【工事内容】（工事名と簡単な作業内容を1〜2行で）
【概算費用】〇〇円〜〇〇円
※現地確認後に正式お見積もりをお送りします。お気軽にご連絡ください📞`;

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
