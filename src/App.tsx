import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RemoteParticipant, RoomOptions } from 'livekit-client'
import { Room, RoomEvent, Track, VideoPresets } from 'livekit-client'
import './App.css'

const STORAGE_ID = 'pet-cam-identity'

/** 뷰어 → 송출: 원격 카메라 전환 (Data channel) */
const PET_CAM_CAMERA_MSG = 'pet-cam-camera' as const
type CameraMode = 'front' | 'back' | 'ultra'

/** LiveKit 방 이름 (고정) */
const ROOM_NAME = '단이 HOUSE'

function getOrCreateIdentity(): string {
  try {
    let id = localStorage.getItem(STORAGE_ID)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(STORAGE_ID, id)
    }
    return id
  } catch {
    return `u-${Math.random().toString(36).slice(2, 12)}`
  }
}

type Role = 'publish' | 'view'

async function fetchToken(body: {
  room: string
  identity: string
  role: Role
  name?: string
}): Promise<{ token: string; url: string }> {
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as {
    token?: string
    url?: string
    error?: string
    hint?: string
  }
  if (!res.ok) {
    throw new Error(data.hint || data.error || `HTTP ${res.status}`)
  }
  if (!data.token || !data.url) {
    throw new Error('invalid_token_response')
  }
  return { token: data.token, url: data.url }
}

function useUrlRole(): Role {
  return useMemo(() => {
    const p = new URLSearchParams(window.location.search)
    return p.get('role') === 'publish' ? 'publish' : 'view'
  }, [])
}

/** 기기 라벨이 짧을 때 — iOS는 'Ultra Wide' 등으로 광각이 따로 뜨는 경우가 많음 */
function formatCameraOptionLabel(d: MediaDeviceInfo, index: number): string {
  const label = d.label?.trim()
  if (!label) {
    return `카메라 ${index + 1}`
  }
  const lower = label.toLowerCase()
  if (
    lower.includes('ultra') ||
    lower.includes('0.5') ||
    label.includes('광각') ||
    label.includes('울트라')
  ) {
    return `${label} (넓게 · 0.5x 후보)`
  }
  return label
}

function isFrontCameraLabel(label: string): boolean {
  const l = label.toLowerCase()
  return (
    l.includes('front') ||
    l.includes('face') ||
    l.includes('selfie') ||
    l.includes('user') ||
    label.includes('전면') ||
    label.includes('셀피')
  )
}

function pickFrontDevice(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  const found = devices.find((d) => d.label && isFrontCameraLabel(d.label))
  if (found) return found
  if (devices.length === 2 && devices.every((d) => !d.label)) {
    return devices[0]
  }
  return undefined
}

/** 기본 후면(보통 와이드). 라벨 없으면 두 번째 카메라 등 */
function pickBackDefaultDevice(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  const notFront = devices.filter((d) => !(d.label && isFrontCameraLabel(d.label)))
  if (notFront.length === 0) return undefined
  const primary = notFront.find((d) => {
    if (!d.label) return false
    const l = d.label.toLowerCase()
    const isBack =
      l.includes('back') ||
      l.includes('rear') ||
      l.includes('environment') ||
      d.label.includes('후면')
    const isUltra =
      l.includes('ultra') || d.label.includes('광각') || l.includes('0.5')
    return isBack && !isUltra
  })
  if (primary) return primary
  if (devices.length === 2 && devices.every((d) => !d.label)) {
    return devices[1]
  }
  return notFront[0]
}

/** 후면 중 울트라와이드·0.5x 후보 (없으면 undefined) */
function pickUltraWideDevice(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  const notFront = devices.filter((d) => !(d.label && isFrontCameraLabel(d.label)))
  return notFront.find((d) => {
    if (!d.label) return false
    const l = d.label.toLowerCase()
    return (
      l.includes('ultra') ||
      l.includes('0.5') ||
      d.label.includes('광각') ||
      d.label.includes('울트라') ||
      (l.includes('wide') && !l.includes('tele'))
    )
  })
}

function resolveCameraDevice(mode: CameraMode, devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  if (mode === 'front') return pickFrontDevice(devices)
  if (mode === 'back') return pickBackDefaultDevice(devices)
  return pickUltraWideDevice(devices) ?? pickBackDefaultDevice(devices)
}

function clampZoom(n: number): number {
  return Math.min(3, Math.max(0.5, Math.round(n * 100) / 100))
}

const RECORD_MAX_MS = 60_000

function pickVideoRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return undefined
  }
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ]
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return undefined
}

function createRoomOptions(role: Role): RoomOptions {
  if (role === 'publish') {
    return {
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        resolution: VideoPresets.h1080.resolution,
        frameRate: { ideal: 30 },
      },
      publishDefaults: {
        videoCodec: 'h264',
        degradationPreference: 'maintain-resolution',
        videoEncoding: {
          ...VideoPresets.h1080.encoding,
          maxBitrate: 5_000_000,
          maxFramerate: 30,
        },
        videoSimulcastLayers: [VideoPresets.h720, VideoPresets.h360],
        simulcast: true,
      },
    }
  }
  return {
    adaptiveStream: { pixelDensity: 'screen' },
    dynacast: true,
  }
}

const APP_DISPLAY_NAME = '단이 HOUSE'

export default function App() {
  useEffect(() => {
    document.title = APP_DISPLAY_NAME
  }, [])

  const urlRole = useUrlRole()
  const [role, setRole] = useState<Role>(() => urlRole)
  const [displayName, setDisplayName] = useState('')
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([])
  const [selectedCameraId, setSelectedCameraId] = useState<string>('')

  const roomRef = useRef<Room | null>(null)
  const remoteWrapRef = useRef<HTMLDivElement>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordChunksRef = useRef<BlobPart[]>([])
  const skipRecordDownloadRef = useRef(false)
  const recordStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recordTickerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recordAutoStoppedRef = useRef(false)
  const videoInputsRef = useRef<MediaDeviceInfo[]>([])
  const publishStageRef = useRef<HTMLDivElement>(null)
  const localZoomWrapRef = useRef<HTMLDivElement>(null)
  const remoteZoomWrapRef = useRef<HTMLDivElement>(null)

  const [localZoom, setLocalZoom] = useState(1)
  const [remoteZoom, setRemoteZoom] = useState(1)
  const [isRecording, setIsRecording] = useState(false)
  const [recordRemainingSec, setRecordRemainingSec] = useState<number | null>(null)
  const remoteZoomRef = useRef(1)
  const localZoomRef = useRef(1)
  useEffect(() => {
    remoteZoomRef.current = remoteZoom
  }, [remoteZoom])
  useEffect(() => {
    localZoomRef.current = localZoom
  }, [localZoom])

  const identity = useMemo(() => getOrCreateIdentity(), [])

  const wakeLockRef = useRef<WakeLockSentinel | null>(null)

  const releaseWakeLock = useCallback(async () => {
    try {
      await wakeLockRef.current?.release()
    } catch {
      /* noop */
    }
    wakeLockRef.current = null
  }, [])

  const requestWakeLock = useCallback(async () => {
    if (!('wakeLock' in navigator)) return
    try {
      await releaseWakeLock()
      const lock = await navigator.wakeLock.request('screen')
      wakeLockRef.current = lock
      lock.addEventListener('release', () => {
        if (wakeLockRef.current === lock) wakeLockRef.current = null
      })
    } catch {
      /* 권한·백그라운드 등으로 실패할 수 있음 */
    }
  }, [releaseWakeLock])

  const clearRecordingSchedulers = useCallback(() => {
    if (recordStopTimerRef.current) {
      clearTimeout(recordStopTimerRef.current)
      recordStopTimerRef.current = null
    }
    if (recordTickerRef.current) {
      clearInterval(recordTickerRef.current)
      recordTickerRef.current = null
    }
  }, [])

  const enterPublishFullscreen = useCallback(() => {
    const el = publishStageRef.current
    if (!el) return
    const anyEl = el as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void
    }
    const req =
      el.requestFullscreen?.bind(el) ?? anyEl.webkitRequestFullscreen?.bind(el)
    if (req) void Promise.resolve(req()).catch(() => {})
  }, [])

  const disconnect = useCallback(async () => {
    const mr = mediaRecorderRef.current
    if (mr && mr.state !== 'inactive') {
      skipRecordDownloadRef.current = true
      clearRecordingSchedulers()
      try {
        mr.stop()
      } catch {
        /* noop */
      }
      mediaRecorderRef.current = null
    }
    setIsRecording(false)
    setRecordRemainingSec(null)

    await releaseWakeLock()
    if (document.fullscreenElement && document.exitFullscreen) {
      try {
        await document.exitFullscreen()
      } catch {
        /* noop */
      }
    }
    const r = roomRef.current
    roomRef.current = null
    if (r) {
      await r.disconnect()
    }
    if (remoteWrapRef.current) {
      remoteWrapRef.current.innerHTML = ''
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null
    }
    setConnected(false)
    setStatus('')
    setConnecting(false)
    setVideoInputs([])
    setSelectedCameraId('')
    setLocalZoom(1)
    setRemoteZoom(1)
  }, [releaseWakeLock, clearRecordingSchedulers])

  const refreshVideoInputs = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      setVideoInputs(list.filter((d) => d.kind === 'videoinput'))
    } catch {
      setVideoInputs([])
    }
  }, [])

  const handleCameraChange = useCallback(
    async (deviceId: string) => {
      const room = roomRef.current
      if (!room || !deviceId) return
      const mr = mediaRecorderRef.current
      if (mr && mr.state !== 'inactive') {
        skipRecordDownloadRef.current = true
        clearRecordingSchedulers()
        try {
          mr.stop()
        } catch {
          /* noop */
        }
        mediaRecorderRef.current = null
        setIsRecording(false)
        setRecordRemainingSec(null)
        setStatus('카메라를 바꿔 녹화를 멈췄어요')
      }
      try {
        await room.switchActiveDevice('videoinput', deviceId)
        setSelectedCameraId(deviceId)
        const v = localVideoRef.current
        const camPub = room.localParticipant.getTrackPublication(Track.Source.Camera)
        if (camPub?.track && v) {
          camPub.track.attach(v)
          void v.play().catch(() => {})
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [clearRecordingSchedulers],
  )

  const stopLocalRecording = useCallback(() => {
    clearRecordingSchedulers()
    const mr = mediaRecorderRef.current
    if (mr && mr.state !== 'inactive') {
      try {
        mr.stop()
      } catch {
        /* noop */
      }
    }
  }, [clearRecordingSchedulers])

  const startLocalRecording = useCallback(() => {
    const room = roomRef.current
    if (!room) return
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      return
    }
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera)
    const vt = pub?.track?.mediaStreamTrack
    if (!vt || vt.readyState !== 'live') {
      setError('카메라가 준비되지 않았어요.')
      return
    }
    if (typeof MediaRecorder === 'undefined') {
      setError('이 브라우저는 녹화를 지원하지 않아요.')
      return
    }
    const mimeType = pickVideoRecorderMimeType()
    if (!mimeType) {
      setError('이 기기에서 쓸 수 있는 동영상 녹화 형식이 없어요.')
      return
    }
    recordChunksRef.current = []
    skipRecordDownloadRef.current = false
    let mr: MediaRecorder
    try {
      mr = new MediaRecorder(new MediaStream([vt]), { mimeType })
    } catch {
      setError('녹화를 시작할 수 없어요.')
      return
    }
    mediaRecorderRef.current = mr
    const startedAt = Date.now()
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) recordChunksRef.current.push(e.data)
    }
    mr.onerror = () => {
      clearRecordingSchedulers()
      recordAutoStoppedRef.current = false
      mediaRecorderRef.current = null
      setIsRecording(false)
      setRecordRemainingSec(null)
      setError('녹화 중 오류가 났어요.')
    }
    mr.onstop = () => {
      const wasAutoStop = recordAutoStoppedRef.current
      clearRecordingSchedulers()
      recordAutoStoppedRef.current = false
      mediaRecorderRef.current = null
      setIsRecording(false)
      setRecordRemainingSec(null)
      const skip = skipRecordDownloadRef.current
      skipRecordDownloadRef.current = false
      const chunks = recordChunksRef.current
      recordChunksRef.current = []
      if (skip) return
      const blob = new Blob(chunks, { type: mimeType })
      if (blob.size === 0) {
        setStatus('녹화 데이터가 비어 있어요.')
        return
      }
      const ext = mimeType.includes('mp4') ? 'mp4' : 'webm'
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `pet-cam-${stamp}.${ext}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setStatus(
        wasAutoStop ? '1분이 지나 자동으로 저장했어요' : '녹화 파일을 저장했어요 (최대 1분)',
      )
    }
    try {
      mr.start(500)
    } catch {
      mediaRecorderRef.current = null
      setError('녹화를 시작할 수 없어요.')
      return
    }
    recordStopTimerRef.current = setTimeout(() => {
      recordStopTimerRef.current = null
      const active = mediaRecorderRef.current
      if (active && active.state !== 'inactive') {
        recordAutoStoppedRef.current = true
        try {
          active.stop()
        } catch {
          /* noop */
        }
      }
    }, RECORD_MAX_MS)
    setError(null)
    setIsRecording(true)
    setRecordRemainingSec(Math.ceil(RECORD_MAX_MS / 1000))
    setStatus('녹화 중… (최대 1분)')
    const tick = () => {
      const left = Math.max(0, Math.ceil((startedAt + RECORD_MAX_MS - Date.now()) / 1000))
      setRecordRemainingSec(left > 0 ? left : 0)
    }
    tick()
    recordTickerRef.current = window.setInterval(tick, 500)
  }, [clearRecordingSchedulers])

  const toggleLocalRecording = useCallback(() => {
    const mr = mediaRecorderRef.current
    if (mr && mr.state !== 'inactive') {
      stopLocalRecording()
    } else {
      startLocalRecording()
    }
  }, [startLocalRecording, stopLocalRecording])

  const applyCameraMode = useCallback(
    (mode: CameraMode, opts?: { fromRemote?: boolean }) => {
      const device = resolveCameraDevice(mode, videoInputsRef.current)
      if (device) {
        setError(null)
        void handleCameraChange(device.deviceId)
        if (opts?.fromRemote) {
          setStatus('시청자 요청으로 카메라 전환')
        }
        return
      }
      const base =
        mode === 'front' ? '전면' : mode === 'back' ? '후면' : '광각(울트라)'
      setError(
        `${base} 카메라를 찾지 못했어요. 태블릿에서 「새로고침」 후 다시 시도해 주세요.`,
      )
    },
    [handleCameraChange],
  )

  const applyCameraModeRef = useRef(applyCameraMode)
  applyCameraModeRef.current = applyCameraMode

  const sendViewerCameraCommand = useCallback(async (mode: CameraMode) => {
    const room = roomRef.current
    if (!room) return
    try {
      setError(null)
      const payload = new TextEncoder().encode(
        JSON.stringify({ type: PET_CAM_CAMERA_MSG, action: mode }),
      )
      await room.localParticipant.publishData(payload, { reliable: true })
      setStatus('태블릿에 카메라 전환을 보냈어요')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const connect = useCallback(async () => {
    setError(null)
    setConnecting(true)
    setStatus('토큰 요청 중…')
    let r: Room | null = null
    try {
      const { token, url } = await fetchToken({
        room: ROOM_NAME,
        identity,
        role,
        name: displayName.trim() || undefined,
      })
      r = new Room(createRoomOptions(role))
      roomRef.current = r

      r.on(RoomEvent.Disconnected, () => {
        setConnected(false)
        setStatus('연결 종료')
      })

      setStatus('룸 연결 중…')
      await r.connect(url, token)

      if (role === 'publish') {
        await r.localParticipant.setMicrophoneEnabled(false)
        await r.localParticipant.setCameraEnabled(true)
        setStatus('카메라 준비됨')
      } else {
        setStatus('시청 준비됨')
      }

      /** ref(비디오 영역)는 `connected === true` 일 때만 DOM에 있음 → 먼저 화면 전환 */
      setConnected(true)
    } catch (e) {
      if (r) await r.disconnect()
      roomRef.current = null
      setError(e instanceof Error ? e.message : String(e))
      setStatus('')
      setConnected(false)
    } finally {
      setConnecting(false)
    }
  }, [displayName, identity, role])

  /** 연결 후 DOM이 생긴 뒤 트랙 붙이기 (이전 버그: ref 없이 return 해서 화면이 안 바뀜) */
  useEffect(() => {
    if (!connected) return
    const r = roomRef.current
    if (!r) return

    const remoteContainer = remoteWrapRef.current
    if (!remoteContainer) return

    const attachRemote = (track: Track) => {
      if (track.kind !== Track.Kind.Video) return
      const el = track.attach()
      if (el instanceof HTMLVideoElement) {
        el.playsInline = true
        el.muted = false
        void el.play().catch(() => {
          /* iOS는 제스처 후 재생될 수 있음 */
        })
      }
      el.className = 'remote-video-el'
      remoteContainer.appendChild(el)
    }

    const onTrackSubscribed = (track: Track) => {
      attachRemote(track)
    }
    const onTrackUnsubscribed = (track: Track) => {
      track.detach()
    }

    r.remoteParticipants.forEach((p) => {
      p.trackPublications.forEach((pub) => {
        if (pub.track && pub.kind === Track.Kind.Video) {
          attachRemote(pub.track)
        }
      })
    })

    r.on(RoomEvent.TrackSubscribed, onTrackSubscribed)
    r.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)

    const onLocalPublished = () => {
      const v = localVideoRef.current
      if (!v) return
      const camPub = r.localParticipant.getTrackPublication(Track.Source.Camera)
      if (camPub?.track) {
        camPub.track.attach(v)
        void v.play().catch(() => {})
      }
    }

    if (role === 'publish') {
      r.on(RoomEvent.LocalTrackPublished, onLocalPublished)
      onLocalPublished()
      setStatus('카메라 송출 중')
    } else {
      setStatus('시청 중 — 송출 기기가 켜지면 여기에 보여요')
    }

    const gridEl = remoteContainer

    return () => {
      r.off(RoomEvent.TrackSubscribed, onTrackSubscribed)
      r.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
      r.off(RoomEvent.LocalTrackPublished, onLocalPublished)
      gridEl.innerHTML = ''
    }
  }, [connected, role])

  /** 송출 중: 사용 가능한 카메라 목록 (광각/울트라와이드는 기기마다 별 줄로 나옴) */
  useEffect(() => {
    if (!connected || role !== 'publish') {
      setVideoInputs([])
      setSelectedCameraId('')
      return
    }
    void refreshVideoInputs()
    const t = window.setTimeout(() => void refreshVideoInputs(), 600)
    const onDeviceChange = () => {
      void refreshVideoInputs()
    }
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
    return () => {
      window.clearTimeout(t)
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
    }
  }, [connected, role, refreshVideoInputs])

  useEffect(() => {
    videoInputsRef.current = videoInputs
  }, [videoInputs])

  /** 시청자가 보낸 카메라 전환 요청 (송출 기기에서만 처리) */
  useEffect(() => {
    if (!connected || role !== 'publish') return
    const room = roomRef.current
    if (!room) return

    const onData = (payload: Uint8Array, participant?: RemoteParticipant) => {
      if (!participant || participant.identity === room.localParticipant.identity) return
      let msg: { type?: string; action?: string }
      try {
        msg = JSON.parse(new TextDecoder().decode(payload)) as {
          type?: string
          action?: string
        }
      } catch {
        return
      }
      if (msg.type !== PET_CAM_CAMERA_MSG) return
      const a = msg.action
      if (a !== 'front' && a !== 'back' && a !== 'ultra') return
      applyCameraModeRef.current(a as CameraMode, { fromRemote: true })
    }

    room.on(RoomEvent.DataReceived, onData)
    return () => {
      room.off(RoomEvent.DataReceived, onData)
    }
  }, [connected, role])

  /** 목록이 바뀌면 현재 선택 값을 룸 상태와 맞춤 */
  useEffect(() => {
    if (!connected || role !== 'publish' || videoInputs.length === 0) return
    const room = roomRef.current
    if (!room) return
    const active = room.getActiveDevice('videoinput')
    const found = active && videoInputs.some((d) => d.deviceId === active)
    if (found && active) {
      setSelectedCameraId(active)
    } else {
      setSelectedCameraId(videoInputs[0].deviceId)
    }
  }, [connected, role, videoInputs])

  useEffect(() => {
    return () => {
      void disconnect()
    }
  }, [disconnect])

  /** 송출: 화면 꺼짐 방지 (가능한 브라우저만) + 탭 복귀 시 다시 요청 */
  useEffect(() => {
    if (!connected || role !== 'publish') {
      void releaseWakeLock()
      return
    }
    void requestWakeLock()
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        void requestWakeLock()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      void releaseWakeLock()
    }
  }, [connected, role, requestWakeLock, releaseWakeLock])

  /** 송출: 레이아웃 전용 클래스 (카메라 영역 최대화) */
  useEffect(() => {
    const on = connected && role === 'publish'
    document.body.classList.toggle('publish-mode', on)
    document.getElementById('root')?.classList.toggle('publish-mode', on)
    return () => {
      document.body.classList.remove('publish-mode')
      document.getElementById('root')?.classList.remove('publish-mode')
    }
  }, [connected, role])

  /** 송출 미리보기: 트랙패드 Ctrl+휠 / 두 손가락 핀치로 확대 */
  useEffect(() => {
    const el = localZoomWrapRef.current
    if (!el || !connected || role !== 'publish') return
    let baseD = 0
    let baseZ = 1
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setLocalZoom((z) => clampZoom(z + e.deltaY * -0.01))
    }
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const [a, b] = [e.touches[0], e.touches[1]]
        baseD = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        baseZ = localZoomRef.current
      }
    }
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || baseD <= 0) return
      e.preventDefault()
      const [a, b] = [e.touches[0], e.touches[1]]
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      setLocalZoom(clampZoom(baseZ * (d / baseD)))
    }
    const onTouchEnd = () => {
      baseD = 0
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [connected, role])

  /** 시청 영상: Ctrl+휠 / 두 손가락 핀치 */
  useEffect(() => {
    const el = remoteZoomWrapRef.current
    if (!el || !connected || role !== 'view') return
    let baseD = 0
    let baseZ = 1
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setRemoteZoom((z) => clampZoom(z + e.deltaY * -0.01))
    }
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const [a, b] = [e.touches[0], e.touches[1]]
        baseD = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        baseZ = remoteZoomRef.current
      }
    }
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || baseD <= 0) return
      e.preventDefault()
      const [a, b] = [e.touches[0], e.touches[1]]
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      setRemoteZoom(clampZoom(baseZ * (d / baseD)))
    }
    const onTouchEnd = () => {
      baseD = 0
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [connected, role])

  return (
    <div className={`app ${connected && role === 'publish' ? 'app--publish' : ''}`}>
      {!(connected && role === 'publish') && (
        <header className="header">
          <div className="brand">
            <span className="brand-emoji" aria-hidden>
              🐾
            </span>
            <h1>{APP_DISPLAY_NAME}</h1>
          </div>
          <p className="tagline">둘만의 작은 홈캠</p>
        </header>
      )}

      {!connected ? (
        <section className="form form-card">
          <fieldset className="role-field">
            <legend>역할</legend>
            <label>
              <input
                type="radio"
                name="role"
                checked={role === 'publish'}
                onChange={() => setRole('publish')}
              />{' '}
              송출 (태블릿 · 카메라)
            </label>
            <label>
              <input
                type="radio"
                name="role"
                checked={role === 'view'}
                onChange={() => setRole('view')}
              />{' '}
              시청 (폰)
            </label>
          </fieldset>

          <label className="field">
            <span>표시 이름 (선택)</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="닉네임"
            />
          </label>

          <button
            type="button"
            className="btn primary"
            disabled={connecting}
            onClick={() => void connect()}
          >
            {connecting ? '연결 중…' : '연결할래요'}
          </button>
          {error && (
            <div className="err-box">
              <p className="err">{error}</p>
              {(error.includes('LIVEKIT') || error.includes('.env')) && (
                <ol className="setup-steps">
                  <li>
                    <code>개인 작업/pet-cam-web/.env</code> 파일이 있는지 확인 (이
                    이름·위치 그대로)
                  </li>
                  <li>
                    LiveKit 대시보드에서 복사한 세 줄을 넣기:{' '}
                    <code>LIVEKIT_URL</code>, <code>LIVEKIT_API_KEY</code>,{' '}
                    <code>LIVEKIT_API_SECRET</code>
                  </li>
                  <li>저장 후 터미널에서 dev 서버를 끄고(Ctrl+C) 다시 실행</li>
                </ol>
              )}
            </div>
          )}
        </section>
      ) : (
        <section
          className={`session ${connected && role === 'publish' ? 'session--publish' : ''}`}
        >
          <div className="session-card">
            <div className="session-bar">
              <span className="pill">{role === 'publish' ? '송출 중' : '시청 중'}</span>
              <span className="room-label">방 · {ROOM_NAME}</span>
              <span className="status">{status}</span>
              <button type="button" className="btn ghost" onClick={() => void disconnect()}>
                나가기
              </button>
            </div>
          </div>

          {role === 'publish' && (
            <div ref={publishStageRef} className="publish-stage">
              <div className="local-wrap local-wrap--publish">
                <button
                  type="button"
                  className="publish-fullscreen-btn"
                  onClick={() => enterPublishFullscreen()}
                >
                  전체 화면
                </button>
                <span className="badge">내 화면 (이렇게 보여요)</span>
                <div ref={localZoomWrapRef} className="zoom-frame zoom-frame--local">
                  <div
                    className="zoom-inner zoom-inner--local"
                    style={{ transform: `scale(${localZoom})` }}
                  >
                    <video
                      ref={localVideoRef}
                      className="local-video local-video--publish"
                      playsInline
                      muted
                    />
                  </div>
                </div>
              </div>
              <div className="camera-picker camera-picker--publish">
                <div className="zoom-bar">
                  <span className="zoom-bar-label">미리보기 확대</span>
                  <button
                    type="button"
                    className="btn ghost btn-small zoom-bar-btn"
                    aria-label="축소"
                    onClick={() => setLocalZoom((z) => clampZoom(z - 0.15))}
                  >
                    −
                  </button>
                  <input
                    className="zoom-slider"
                    type="range"
                    min={0.5}
                    max={3}
                    step={0.05}
                    value={localZoom}
                    onChange={(e) => setLocalZoom(clampZoom(Number(e.target.value)))}
                    aria-label="미리보기 확대 비율"
                  />
                  <button
                    type="button"
                    className="btn ghost btn-small zoom-bar-btn"
                    aria-label="확대"
                    onClick={() => setLocalZoom((z) => clampZoom(z + 0.15))}
                  >
                    +
                  </button>
                  <span className="zoom-bar-pct">{Math.round(localZoom * 100)}%</span>
                </div>
                <label className="camera-picker-label" htmlFor="camera-device">
                  카메라
                </label>
                <div className="camera-picker-row">
                  <select
                    id="camera-device"
                    className="camera-select"
                    value={selectedCameraId}
                    onChange={(e) => void handleCameraChange(e.target.value)}
                  >
                    {videoInputs.length === 0 ? (
                      <option value="">목록 불러오는 중…</option>
                    ) : (
                      videoInputs.map((d, i) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {formatCameraOptionLabel(d, i)}
                        </option>
                      ))
                    )}
                  </select>
                  <button
                    type="button"
                    className="btn ghost btn-small"
                    onClick={() => void refreshVideoInputs()}
                  >
                    새로고침
                  </button>
                </div>
                <div className="facing-row">
                  <button
                    type="button"
                    className="btn ghost btn-small facing-btn"
                    onClick={() => applyCameraMode('front')}
                  >
                    전면
                  </button>
                  <button
                    type="button"
                    className="btn ghost btn-small facing-btn"
                    onClick={() => applyCameraMode('back')}
                  >
                    후면
                  </button>
                  <button
                    type="button"
                    className="btn ghost btn-small facing-btn"
                    onClick={() => applyCameraMode('ultra')}
                  >
                    광각
                  </button>
                </div>
                <div className="record-row">
                  <button
                    type="button"
                    className={`btn btn-small ${isRecording ? 'record-active' : 'ghost'}`}
                    onClick={() => void toggleLocalRecording()}
                  >
                    {isRecording ? '녹화 중지' : '녹화 시작'}
                  </button>
                  {isRecording && recordRemainingSec !== null ? (
                    <span className="record-remaining" aria-live="polite">
                      남은 {recordRemainingSec}초 · 최대 1분
                    </span>
                  ) : (
                    <span className="record-hint">최대 1분까지 저장돼요</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {role === 'view' && (
            <>
              <div className="zoom-bar zoom-bar--viewer">
                <span className="zoom-bar-label">확대</span>
                <button
                  type="button"
                  className="btn ghost btn-small zoom-bar-btn"
                  aria-label="축소"
                  onClick={() => setRemoteZoom((z) => clampZoom(z - 0.15))}
                >
                  −
                </button>
                <input
                  className="zoom-slider"
                  type="range"
                  min={0.5}
                  max={3}
                  step={0.05}
                  value={remoteZoom}
                  onChange={(e) => setRemoteZoom(clampZoom(Number(e.target.value)))}
                  aria-label="시청 화면 확대 비율"
                />
                <button
                  type="button"
                  className="btn ghost btn-small zoom-bar-btn"
                  aria-label="확대"
                  onClick={() => setRemoteZoom((z) => clampZoom(z + 0.15))}
                >
                  +
                </button>
                <span className="zoom-bar-pct">{Math.round(remoteZoom * 100)}%</span>
              </div>
            </>
          )}

          <div
            ref={remoteZoomWrapRef}
            className={`zoom-frame zoom-frame--remote ${role === 'view' ? 'zoom-frame--remote-active' : ''}`}
          >
            <div
              className="zoom-inner zoom-inner--remote"
              style={{ transform: `scale(${remoteZoom})` }}
            >
              <div className="remote-grid" ref={remoteWrapRef} />
            </div>
          </div>

          {role === 'view' && (
            <>
              <div className="viewer-remote-camera viewer-remote-camera--below">
                <span className="viewer-remote-label">태블릿 카메라 (원격)</span>
                <div className="facing-row viewer-facing-row">
                  <button
                    type="button"
                    className="btn ghost btn-small facing-btn"
                    aria-label="태블릿 전면 카메라로 전환 요청"
                    onClick={() => void sendViewerCameraCommand('front')}
                  >
                    전면
                  </button>
                  <button
                    type="button"
                    className="btn ghost btn-small facing-btn"
                    aria-label="태블릿 후면 카메라로 전환 요청"
                    onClick={() => void sendViewerCameraCommand('back')}
                  >
                    후면
                  </button>
                  <button
                    type="button"
                    className="btn ghost btn-small facing-btn"
                    aria-label="태블릿 광각(울트라와이드) 카메라로 전환 요청"
                    onClick={() => void sendViewerCameraCommand('ultra')}
                  >
                    광각
                  </button>
                </div>
              </div>
              <p className="viewer-empty-hint">
                영상이 없으면 태블릿에서 먼저 송출을 켜 주세요.
              </p>
            </>
          )}
        </section>
      )}
    </div>
  )
}
