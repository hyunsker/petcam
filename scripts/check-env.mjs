import { config as loadEnv } from 'dotenv'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
loadEnv({ path: join(root, '.env') })
loadEnv({ path: join(root, '.env.local'), override: true })

const u = process.env.LIVEKIT_URL
const k = process.env.LIVEKIT_API_KEY
const s = process.env.LIVEKIT_API_SECRET

console.log(`프로젝트 루트: ${root}`)
console.log(`읽는 파일: ${join(root, '.env')}`)
console.log('')
if (u && k && s) {
  console.log('OK: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET 모두 설정됨')
  console.log(`LIVEKIT_URL = ${u.slice(0, 24)}...`)
} else {
  console.log('아직 설정이 비어 있습니다:')
  console.log(`  LIVEKIT_URL: ${u ? 'OK' : '없음'}`)
  console.log(`  LIVEKIT_API_KEY: ${k ? 'OK' : '없음'}`)
  console.log(`  LIVEKIT_API_SECRET: ${s ? 'OK' : '없음'}`)
  process.exitCode = 1
}
