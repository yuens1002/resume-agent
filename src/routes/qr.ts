import { Hono } from 'hono'
import QRCode from 'qrcode'

// QR_TARGET_URL — set to your Custom GPT URL (e.g. https://chatgpt.com/g/g-XXXXX) after creating the GPT.
// Falls back to PUBLIC_URL then https://agent.yuens.me if unset.

const app = new Hono()

app.get('/', async (c) => {
  const target = process.env.QR_TARGET_URL
    ?? process.env.PUBLIC_URL
    ?? new URL(c.req.url).origin

  const png = await QRCode.toBuffer(target, {
    errorCorrectionLevel: 'M',
    width: 300,
    margin: 2,
  })

  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=3600',
    },
  })
})

export default app
