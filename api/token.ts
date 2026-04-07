import type { VercelRequest, VercelResponse } from '@vercel/node'
import { AccessToken, TrackSource } from 'livekit-server-sdk'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' })
    return
  }

  const body = typeof req.body === 'object' && req.body ? req.body : {}
  const room = typeof body.room === 'string' ? body.room.trim() : ''
  const identity =
    typeof body.identity === 'string' && body.identity.trim()
      ? body.identity.trim()
      : `user-${Math.random().toString(36).slice(2, 10)}`
  const role = body.role === 'publish' ? 'publish' : 'view'
  const name = typeof body.name === 'string' ? body.name.trim() : undefined

  if (!room || room.length > 128) {
    res.status(400).json({ error: 'invalid_room' })
    return
  }

  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  const wsUrl = process.env.LIVEKIT_URL

  if (!apiKey || !apiSecret || !wsUrl) {
    res.status(500).json({
      error: 'server_misconfigured',
      hint:
        'Vercel → 프로젝트 → Settings → Environment Variables 에 LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET 을 추가한 뒤 Redeploy 하세요.',
    })
    return
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: name || (role === 'publish' ? '송출' : '시청'),
    ttl: '12h',
  })

  if (role === 'publish') {
    at.addGrant({
      roomJoin: true,
      room,
      canSubscribe: true,
      canPublish: true,
      canPublishData: true,
    })
  } else {
    at.addGrant({
      roomJoin: true,
      room,
      canSubscribe: true,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canPublishData: true,
    })
  }

  const token = await at.toJwt()
  res.status(200).json({ token, url: wsUrl })
}
