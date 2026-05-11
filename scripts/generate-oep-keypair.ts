import { generateKeyPairSync } from 'node:crypto'
import { fingerprint, buildTxtRecord } from '../src/lib/oep-key.js'

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')

const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
const rawPrivate = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32)

const encodedPublic = base64url(Buffer.from(rawPublic))
const encodedPrivate = base64url(Buffer.from(rawPrivate))
const fp = fingerprint(new Uint8Array(rawPublic))
const issuedAt = new Date().toISOString()

const lines = [
  '# OEP keypair generated. Copy these into Railway env vars:',
  '',
  `OEP_PUBLIC_KEY=${encodedPublic}`,
  `OEP_PRIVATE_KEY=${encodedPrivate}   # secret — Railway only, never in git`,
  `OEP_KEY_ISSUED_AT=${issuedAt}`,
  '',
  '# Then publish this DNS TXT record at _oep.<your-root-domain>:',
  '',
  buildTxtRecord(fp),
  '',
  '# Verify with:',
  '#   npx tsx scripts/verify-oep-domain.ts <your-root-domain>',
  '',
]

process.stdout.write(lines.join('\n'))
