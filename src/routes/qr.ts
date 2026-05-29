import { Hono } from 'hono'
import QRCode from 'qrcode'

// QR_TARGET_URL — set to your Custom GPT URL (e.g. https://chatgpt.com/g/g-XXXXX) after creating the GPT.
// Falls back to PUBLIC_URL then https://agent.yuens.me if unset.

const app = new Hono()

app.get('/', async (c) => {
  const target = process.env.QR_TARGET_URL
    ?? process.env.PUBLIC_URL
    ?? 'https://agent.yuens.me'

  const png = await QRCode.toBuffer(target, {
    errorCorrectionLevel: 'M',
    width: 300,
    margin: 2,
  })

  c.header('Content-Type', 'image/png')
  c.header('Cache-Control', 'public, max-age=3600')
  return c.body(png)
})

export default app
