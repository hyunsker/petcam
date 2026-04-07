import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  RemoteParticipant,
  RemoteTrackPublication,
  RoomOptions,
} from 'livekit-client'
import { Room, RoomEvent, Track, VideoPresets } from 'livekit-client'
import './App.css'

const STORAGE_ID = 'pet-cam-identity'
const STORAGE_PUBLISH_SLOT = 'pet-cam-publish-slot'

const SLOT_LABELS = { '1': '큰방', '2': '거실' } as const

/** 송출 표시 이름에 포함(거실). 시청 화면만 좌우 반전 — 아이패드 거실만 자연스럽게 */
function isLivingRoomRemoteLabel(name: string): boolean {
  return name.includes('거실')
}

/** 시청 화면에서 타일 순서: 큰방 → 거실 → 나머지 */
function viewerStreamOrder(name: string): number {
  if (name.includes('1번') || name.includes('큰방')) return 1
  if (name.includes('2번') || name.includes('거실')) return 2
  return 50
}

function sortViewerRemoteTiles(container: HTMLElement) {
  const tiles = [...container.children].filter(
    (c): c is HTMLElement => c.classList.contains('remote-tile'),
  )
  tiles.sort((a, b) => {
    const oa = Number(a.dataset.viewerOrder) || 99
    const ob = Number(b.dataset.viewerOrder) || 99
    if (oa !== ob) return oa - ob
    const la = a.querySelector('.remote-tile-label')?.textContent ?? ''
    const lb = b.querySelector('.remote-tile-label')?.textContent ?? ''
    return la.localeCompare(lb, 'ko')
  })
  tiles.forEach((t) => container.appendChild(t))
}

function looksLikePublisherName(name: string): boolean {
  return (
    name.includes('1번') ||
    name.includes('2번') ||
    name.includes('큰방') ||
    name.includes('거실')
  )
}

function normalizeViewerName(name: string): 'donghyun' | 'dahye' | null {
  const n = name.trim()
  if (n.includes('동현')) return 'donghyun'
  if (n.includes('다혜')) return 'dahye'
  return null
}

function formatSec2(n: number | null): string {
  const s = Math.max(0, Math.floor(n ?? 0))
  return `${String(s).padStart(2, '0')}초`
}

function readInitialPublishSlot(): '1' | '2' {
  const p = new URLSearchParams(window.location.search).get('slot')
  if (p === '1' || p === '2') return p
  try {
    const s = localStorage.getItem(STORAGE_PUBLISH_SLOT)
    if (s === '1' || s === '2') return s
  } catch {
    /* noop */
  }
  return '1'
}

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
type ConnBadge = 'offline' | 'connecting' | 'live' | 'reconnecting' | 'error'

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

/** 시청 화면 확대: 100% 미만으로 내려가면 화면이 사라지는 것처럼 보여 최소 100% 고정 */
function clampRemoteZoom(n: number): number {
  return Math.min(3, Math.max(1, Math.round(n * 100) / 100))
}

function isVideoEl(v: unknown): v is HTMLVideoElement {
  return typeof window !== 'undefined' && v instanceof HTMLVideoElement
}

const RECORD_MAX_MS = 120_000

function pickVideoRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
    return undefined
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''
  const isIOS = /iPhone|iPad|iPod/i.test(ua)
  const candidates = isIOS
    ? ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
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
  const [displayName, setDisplayName] = useState(() => (urlRole === 'view' ? '다혜' : ''))
  const [publishSlot, setPublishSlot] = useState<'1' | '2'>(readInitialPublishSlot)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([])
  const [selectedCameraId, setSelectedCameraId] = useState<string>('')
  const [connBadge, setConnBadge] = useState<ConnBadge>('offline')
  const fitMode: 'contain' = 'contain'
  const [reconnectAttempt, setReconnectAttempt] = useState(0)

  const roomRef = useRef<Room | null>(null)
  const remoteWrapRef = useRef<HTMLDivElement>(null)
  const remoteAudioSinkRef = useRef<HTMLDivElement>(null)
  const tileOverlayRef = useRef<HTMLDivElement>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordChunksRef = useRef<BlobPart[]>([])
  const skipRecordDownloadRef = useRef(false)
  const recordStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recordTickerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recordAutoStoppedRef = useRef(false)
  const viewerRecorderRef = useRef<MediaRecorder | null>(null)
  const viewerRecordChunksRef = useRef<BlobPart[]>([])
  const viewerRecordStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewerRecordTickerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const viewerRecordAutoStoppedRef = useRef(false)
  const viewerRecordCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewerRecordRafRef = useRef<number | null>(null)
  const viewerRecordStreamRef = useRef<MediaStream | null>(null)
  const videoInputsRef = useRef<MediaDeviceInfo[]>([])
  const publishStageRef = useRef<HTMLDivElement>(null)
  const localZoomWrapRef = useRef<HTMLDivElement>(null)
  const remoteZoomWrapRef = useRef<HTMLDivElement>(null)
  const viewerImmersiveRef = useRef<HTMLDivElement>(null)

  const [localZoom, setLocalZoom] = useState(1)
  const [remoteZoom, setRemoteZoom] = useState(1)
  /** 시청: 확대 기준점(%), 드래그 이동(px) — 모서리 강아지도 확대 후 찾을 수 있게 */
  const [remotePan, setRemotePan] = useState({ x: 0, y: 0 })
  const [remoteFocusPct, setRemoteFocusPct] = useState({ x: 50, y: 50 })
  const tileFsRef = useRef<{
    video: HTMLVideoElement
    placeholder: Comment
    originalParent: HTMLElement
    label: string
  } | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [recordRemainingSec, setRecordRemainingSec] = useState<number | null>(null)
  const [isViewerRecording, setIsViewerRecording] = useState(false)
  const [viewerRecordRemainingSec, setViewerRecordRemainingSec] = useState<number | null>(null)
  const [publishMicEnabled, setPublishMicEnabled] = useState(true)
  const [viewerMicEnabled, setViewerMicEnabled] = useState(false)
  const [viewerPresence, setViewerPresence] = useState<{ donghyun: boolean; dahye: boolean }>({
    donghyun: false,
    dahye: false,
  })
  const [savedPreview, setSavedPreview] = useState<{
    url: string
    mimeType: string
    fileName: string
    blob: Blob
  } | null>(null)
  const remoteZoomRef = useRef(1)
  const remotePanRef = useRef({ x: 0, y: 0 })
  const localZoomRef = useRef(1)
  useEffect(() => {
    remoteZoomRef.current = remoteZoom
  }, [remoteZoom])
  useEffect(() => {
    remotePanRef.current = remotePan
  }, [remotePan])
  useEffect(() => {
    localZoomRef.current = localZoom
  }, [localZoom])

  const identity = useMemo(() => getOrCreateIdentity(), [])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PUBLISH_SLOT, publishSlot)
    } catch {
      /* noop */
    }
  }, [publishSlot])

  useEffect(() => {
    if (role === 'view') {
      if (displayName !== '동현' && displayName !== '다혜') {
        setDisplayName('다혜')
      }
      return
    }
    // 송출 모드에서는 이름 선택을 쓰지 않음
    if (displayName) setDisplayName('')
  }, [role, displayName])

  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const manualDisconnectRef = useRef(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hasEverConnectedRef = useRef(false)
  const connectRef = useRef<(() => Promise<void>) | null>(null)

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

  const clearViewerRecordingSchedulers = useCallback(() => {
    if (viewerRecordStopTimerRef.current) {
      clearTimeout(viewerRecordStopTimerRef.current)
      viewerRecordStopTimerRef.current = null
    }
    if (viewerRecordTickerRef.current) {
      clearInterval(viewerRecordTickerRef.current)
      viewerRecordTickerRef.current = null
    }
    if (viewerRecordRafRef.current !== null) {
      cancelAnimationFrame(viewerRecordRafRef.current)
      viewerRecordRafRef.current = null
    }
  }, [])

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  const closeSavedPreview = useCallback(() => {
    setSavedPreview((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url)
      return null
    })
  }, [])

  useEffect(() => {
    return () => {
      setSavedPreview((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url)
        return null
      })
    }
  }, [])

  const shareSavedPreview = useCallback(async () => {
    const item = savedPreview
    if (!item) return
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
      setStatus('이 브라우저는 공유 기능을 지원하지 않아요')
      return
    }
    const file = new File([item.blob], item.fileName, { type: item.mimeType })
    try {
      await navigator.share({ files: [file], title: '펫캠 저장' })
      setStatus('공유창을 열었어요. 사진 앱 저장을 선택해 주세요')
    } catch {
      setStatus('공유를 취소했거나 실패했어요')
    }
  }, [savedPreview])

  const scheduleReconnect = useCallback(() => {
    if (manualDisconnectRef.current) return
    clearReconnectTimer()
    const nextAttempt = reconnectAttempt + 1
    setReconnectAttempt(nextAttempt)
    setConnBadge('reconnecting')
    setStatus(`연결이 끊겨 자동 재연결 시도 중… (${nextAttempt})`)
    const delay = Math.min(8000, 1200 * nextAttempt)
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      if (manualDisconnectRef.current) return
      void connectRef.current?.()
    }, delay)
  }, [clearReconnectTimer, reconnectAttempt])

  const saveBlobWithShare = useCallback(
    async (
      blob: Blob,
      fileName: string,
      mimeType: string,
      shareTitle: string,
      successStatus: string,
    ) => {
      const file = new File([blob], fileName, { type: mimeType })
      const canUseShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
      if (canUseShare) {
        try {
          await navigator.share({ files: [file], title: shareTitle })
          setStatus(successStatus)
          return
        } catch {
          /* 공유 취소/실패면 아래 fallback */
        }
      }
      setSavedPreview((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url)
        return {
          url: URL.createObjectURL(blob),
          mimeType,
          fileName,
          blob,
        }
      })
      setStatus(
        mimeType.startsWith('image/')
          ? '미리보기에서 길게 눌러 사진에 저장해 주세요'
          : '미리보기에서 공유 버튼으로 저장해 주세요',
      )
    },
    [],
  )

  const saveSnapshotFromVideo = useCallback(async (video: HTMLVideoElement, prefix: string) => {
    const ensureFrameReady = async () => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) return
      await new Promise<void>((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          video.removeEventListener('loadeddata', finish)
          video.removeEventListener('playing', finish)
          resolve()
        }
        video.addEventListener('loadeddata', finish, { once: true })
        video.addEventListener('playing', finish, { once: true })
        setTimeout(finish, 350)
      })
    }
    await ensureFrameReady()
    const w = video.videoWidth || video.clientWidth
    const h = video.videoHeight || video.clientHeight
    if (!w || !h) {
      setStatus('캡쳐할 영상이 아직 준비되지 않았어요')
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setStatus('캡쳐를 만들 수 없어요')
      return
    }
    try {
      ctx.drawImage(video, 0, 0, w, h)
    } catch {
      setStatus('캡쳐에 실패했어요. 잠시 뒤 다시 시도해 주세요')
      return
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const fileName = `${prefix}-${stamp}.png`
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/png')
    })
    if (!blob) {
      setStatus('캡쳐를 만들 수 없어요')
      return
    }
    await saveBlobWithShare(blob, fileName, 'image/png', '펫캠 캡쳐', '공유창을 열었어요. 사진 앱 저장을 눌러 주세요')
  }, [saveBlobWithShare])

  const captureLocalPreview = useCallback(() => {
    const v = localVideoRef.current
    if (!v) return
    saveSnapshotFromVideo(v, 'pet-cam-publish')
  }, [saveSnapshotFromVideo])

  const captureRemoteView = useCallback(() => {
    const v = remoteWrapRef.current?.querySelector<HTMLVideoElement>('video.remote-video-el')
    if (!v) {
      setStatus('캡쳐할 송출 영상이 없어요')
      return
    }
    saveSnapshotFromVideo(v, 'pet-cam-view')
  }, [saveSnapshotFromVideo])

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
    manualDisconnectRef.current = true
    clearReconnectTimer()
    setReconnectAttempt(0)
    if (document.fullscreenElement && document.exitFullscreen) {
      try {
        await document.exitFullscreen()
      } catch {
        /* noop */
      }
    }
    try {
      screen.orientation?.unlock?.()
    } catch {
      /* noop */
    }

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
    const vmr = viewerRecorderRef.current
    if (vmr && vmr.state !== 'inactive') {
      clearViewerRecordingSchedulers()
      try {
        vmr.stop()
      } catch {
        /* noop */
      }
      viewerRecorderRef.current = null
    }
    viewerRecordStreamRef.current?.getTracks().forEach((t) => t.stop())
    viewerRecordStreamRef.current = null
    viewerRecordCanvasRef.current = null
    setIsRecording(false)
    setRecordRemainingSec(null)
    setIsViewerRecording(false)
    setViewerRecordRemainingSec(null)

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
    remoteAudioSinkRef.current?.replaceChildren()
    // disconnect는 exitTilePseudoFullscreen 정의보다 위에 있어 inline 처리
    try {
      const fs = tileFsRef.current
      const overlay = tileOverlayRef.current
      if (fs && overlay) {
        overlay.classList.remove('tile-pseudo-fs--active')
        overlay.replaceChildren()
        try {
          fs.originalParent.replaceChild(fs.video, fs.placeholder)
        } catch {
          /* noop */
        }
        tileFsRef.current = null
        void fs.video.play().catch(() => {})
      }
    } catch {
      /* noop */
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null
    }
    setPublishMicEnabled(true)
    setViewerMicEnabled(false)
    setConnected(false)
    setConnBadge('offline')
    setStatus('')
    setConnecting(false)
    setVideoInputs([])
    setSelectedCameraId('')
    setLocalZoom(1)
    setRemoteZoom(1)
    setRemotePan({ x: 0, y: 0 })
    setRemoteFocusPct({ x: 50, y: 50 })
    hasEverConnectedRef.current = false
  }, [releaseWakeLock, clearRecordingSchedulers, clearViewerRecordingSchedulers, clearReconnectTimer])

  useEffect(() => {
    if (remoteZoom <= 1) {
      setRemotePan({ x: 0, y: 0 })
      setRemoteFocusPct({ x: 50, y: 50 })
    }
  }, [remoteZoom])

  useEffect(() => {
    if (!connected || role !== 'view') {
      setViewerPresence({ donghyun: false, dahye: false })
      return
    }
    const room = roomRef.current
    if (!room) return
    const me = room.localParticipant.identity

    const sync = () => {
      const presence = { donghyun: false, dahye: false }

      const myViewer = normalizeViewerName(displayName)
      if (myViewer) presence[myViewer] = true

      room.remoteParticipants.forEach((p) => {
        if (p.identity === me) return
        const n = p.name?.trim() || p.identity
        const hasCamera = [...p.trackPublications.values()].some(
          (pub) => pub.source === Track.Source.Camera,
        )
        if (hasCamera || looksLikePublisherName(n)) return
        const v = normalizeViewerName(n)
        if (v) presence[v] = true
      })
      setViewerPresence(presence)
    }

    sync()
    room.on(RoomEvent.ParticipantConnected, sync)
    room.on(RoomEvent.ParticipantDisconnected, sync)
    room.on(RoomEvent.ParticipantMetadataChanged, sync)
    room.on(RoomEvent.TrackSubscribed, sync)
    room.on(RoomEvent.TrackUnsubscribed, sync)
    return () => {
      room.off(RoomEvent.ParticipantConnected, sync)
      room.off(RoomEvent.ParticipantDisconnected, sync)
      room.off(RoomEvent.ParticipantMetadataChanged, sync)
      room.off(RoomEvent.TrackSubscribed, sync)
      room.off(RoomEvent.TrackUnsubscribed, sync)
    }
  }, [connected, role, displayName])

  const exitTilePseudoFullscreen = useCallback(() => {
    const fs = tileFsRef.current
    const overlay = tileOverlayRef.current
    if (!fs || !overlay) return
    try {
      overlay.classList.remove('tile-pseudo-fs--active')
      overlay.replaceChildren()
    } catch {
      /* noop */
    }
    try {
      fs.originalParent.replaceChild(fs.video, fs.placeholder)
    } catch {
      /* noop */
    }
    tileFsRef.current = null
    void fs.video.play().catch(() => {})
  }, [])

  const enterTilePseudoFullscreen = useCallback(
    (video: HTMLVideoElement, label: string) => {
      const overlay = tileOverlayRef.current
      const parent = video.parentElement as HTMLElement | null
      if (!overlay || !parent) return
      if (tileFsRef.current?.video === video) {
        exitTilePseudoFullscreen()
        return
      }
      // 다른 타일이 이미 열려 있으면 먼저 닫기
      exitTilePseudoFullscreen()

      const placeholder = document.createComment('tile-fs-placeholder')
      parent.replaceChild(placeholder, video)

      const bar = document.createElement('div')
      bar.className = 'tile-pseudo-fs-bar'
      const title = document.createElement('div')
      title.className = 'tile-pseudo-fs-title'
      title.textContent = label
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'btn ghost btn-small'
      close.textContent = '닫기'
      close.addEventListener('click', () => exitTilePseudoFullscreen())
      bar.appendChild(title)
      bar.appendChild(close)

      const stage = document.createElement('div')
      stage.className = 'tile-pseudo-fs-stage'
      stage.appendChild(video)
      overlay.replaceChildren(bar, stage)
      overlay.classList.add('tile-pseudo-fs--active')

      tileFsRef.current = { video, placeholder, originalParent: parent, label }

      void video.play().catch(() => {})
      void roomRef.current?.startAudio().catch(() => {})
    },
    [exitTilePseudoFullscreen],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitTilePseudoFullscreen()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [exitTilePseudoFullscreen])

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
        setRecordRemainingSec(0)
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
      setRecordRemainingSec(0)
      setError('녹화 중 오류가 났어요.')
    }
    mr.onstop = () => {
      const wasAutoStop = recordAutoStoppedRef.current
      clearRecordingSchedulers()
      recordAutoStoppedRef.current = false
      mediaRecorderRef.current = null
      setIsRecording(false)
      setRecordRemainingSec(0)
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
      void saveBlobWithShare(
        blob,
        `pet-cam-${stamp}.${ext}`,
        mimeType,
        '펫캠 녹화',
        wasAutoStop ? '녹화를 마쳐 공유창을 열었어요' : '공유창을 열었어요. 사진 앱 저장을 눌러 주세요',
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
    setRecordRemainingSec(0)
    setStatus('녹화 중…')
    const tick = () => {
      const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      setRecordRemainingSec(elapsed)
    }
    tick()
    recordTickerRef.current = window.setInterval(tick, 500)
  }, [clearRecordingSchedulers, saveBlobWithShare])

  const toggleLocalRecording = useCallback(() => {
    const mr = mediaRecorderRef.current
    if (mr && mr.state !== 'inactive') {
      stopLocalRecording()
    } else {
      startLocalRecording()
    }
  }, [startLocalRecording, stopLocalRecording])

  const stopViewerRecording = useCallback(() => {
    clearViewerRecordingSchedulers()
    const mr = viewerRecorderRef.current
    if (mr && mr.state !== 'inactive') {
      try {
        mr.stop()
      } catch {
        /* noop */
      }
    }
    viewerRecordStreamRef.current?.getTracks().forEach((t) => t.stop())
    viewerRecordStreamRef.current = null
    viewerRecordCanvasRef.current = null
  }, [clearViewerRecordingSchedulers])

  const startViewerRecording = useCallback(() => {
    const video = remoteWrapRef.current?.querySelector<HTMLVideoElement>('video.remote-video-el')
    if (!video) {
      setStatus('녹화할 송출 영상이 없어요')
      return
    }
    if (viewerRecorderRef.current && viewerRecorderRef.current.state !== 'inactive') return
    if (typeof MediaRecorder === 'undefined') {
      setError('이 브라우저는 녹화를 지원하지 않아요.')
      return
    }
    const mimeType = pickVideoRecorderMimeType()
    if (!mimeType) {
      setError('이 기기에서 쓸 수 있는 동영상 녹화 형식이 없어요.')
      return
    }
    const anyVideo = video as HTMLVideoElement & {
      captureStream?: () => MediaStream
      webkitCaptureStream?: () => MediaStream
    }
    let stream = anyVideo.captureStream?.() ?? anyVideo.webkitCaptureStream?.()
    // Safari 계열 fallback: video.captureStream이 없으면 canvas 캡쳐 스트림 사용
    if (!stream) {
      const w = video.videoWidth || 1280
      const h = video.videoHeight || 720
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        setError('이 브라우저에서는 시청 화면 녹화를 지원하지 않아요.')
        return
      }
      const draw = () => {
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        } catch {
          /* noop */
        }
        viewerRecordRafRef.current = requestAnimationFrame(draw)
      }
      draw()
      const anyCanvas = canvas as HTMLCanvasElement & {
        captureStream?: (fps?: number) => MediaStream
      }
      stream = anyCanvas.captureStream?.(24)
      if (!stream) {
        if (viewerRecordRafRef.current !== null) {
          cancelAnimationFrame(viewerRecordRafRef.current)
          viewerRecordRafRef.current = null
        }
        setError('이 브라우저에서는 시청 화면 녹화를 지원하지 않아요.')
        return
      }
      viewerRecordCanvasRef.current = canvas
    }
    viewerRecordStreamRef.current = stream
    viewerRecordChunksRef.current = []
    let mr: MediaRecorder
    try {
      mr = new MediaRecorder(stream, { mimeType })
    } catch {
      setError('시청 화면 녹화를 시작할 수 없어요.')
      return
    }
    viewerRecorderRef.current = mr
    const startedAt = Date.now()
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) viewerRecordChunksRef.current.push(e.data)
    }
    mr.onerror = () => {
      clearViewerRecordingSchedulers()
      viewerRecordAutoStoppedRef.current = false
      viewerRecorderRef.current = null
      setIsViewerRecording(false)
      setViewerRecordRemainingSec(0)
      setError('시청 화면 녹화 중 오류가 났어요.')
    }
    mr.onstop = () => {
      const wasAutoStop = viewerRecordAutoStoppedRef.current
      clearViewerRecordingSchedulers()
      viewerRecordAutoStoppedRef.current = false
      viewerRecorderRef.current = null
      setIsViewerRecording(false)
      setViewerRecordRemainingSec(0)
      viewerRecordStreamRef.current?.getTracks().forEach((t) => t.stop())
      viewerRecordStreamRef.current = null
      viewerRecordCanvasRef.current = null
      const chunks = viewerRecordChunksRef.current
      viewerRecordChunksRef.current = []
      const blob = new Blob(chunks, { type: mimeType })
      if (blob.size === 0) {
        setStatus('녹화 데이터가 비어 있어요.')
        return
      }
      const ext = mimeType.includes('mp4') ? 'mp4' : 'webm'
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      void saveBlobWithShare(
        blob,
        `pet-cam-view-${stamp}.${ext}`,
        mimeType,
        '펫캠 시청 녹화',
        wasAutoStop ? '녹화를 마쳐 공유창을 열었어요' : '공유창을 열었어요. 사진 앱 저장을 눌러 주세요',
      )
    }
    try {
      mr.start(500)
    } catch {
      viewerRecorderRef.current = null
      setError('시청 화면 녹화를 시작할 수 없어요.')
      return
    }
    viewerRecordStopTimerRef.current = setTimeout(() => {
      viewerRecordStopTimerRef.current = null
      const active = viewerRecorderRef.current
      if (active && active.state !== 'inactive') {
        viewerRecordAutoStoppedRef.current = true
        try {
          active.stop()
        } catch {
          /* noop */
        }
      }
    }, RECORD_MAX_MS)
    setError(null)
    setIsViewerRecording(true)
    setViewerRecordRemainingSec(0)
    setStatus('시청 화면 녹화 중…')
    const tick = () => {
      const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      setViewerRecordRemainingSec(elapsed)
    }
    tick()
    viewerRecordTickerRef.current = window.setInterval(tick, 500)
  }, [clearViewerRecordingSchedulers, saveBlobWithShare])

  const toggleViewerRecording = useCallback(() => {
    const mr = viewerRecorderRef.current
    if (mr && mr.state !== 'inactive') {
      stopViewerRecording()
    } else {
      startViewerRecording()
    }
  }, [startViewerRecording, stopViewerRecording])

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

  const sendViewerCameraCommand = useCallback(
    async (mode: CameraMode, destinationIdentity: string) => {
      const room = roomRef.current
      if (!room || !destinationIdentity) return
      try {
        setError(null)
        const payload = new TextEncoder().encode(
          JSON.stringify({ type: PET_CAM_CAMERA_MSG, action: mode }),
        )
        await room.localParticipant.publishData(payload, {
          reliable: true,
          destinationIdentities: [destinationIdentity],
        })
        setStatus('선택한 송출에 카메라 전환을 보냈어요')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [],
  )

  const togglePublishMic = useCallback(async () => {
    const room = roomRef.current
    if (!room) return
    const next = !publishMicEnabled
    try {
      await room.localParticipant.setMicrophoneEnabled(next)
      setPublishMicEnabled(next)
      setError(null)
      setStatus(next ? '마이크 켜짐' : '마이크 꺼짐')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [publishMicEnabled])

  const toggleViewerMic = useCallback(async () => {
    const room = roomRef.current
    if (!room) return
    const next = !viewerMicEnabled
    try {
      await room.localParticipant.setMicrophoneEnabled(next)
      if (next) void room.startAudio()
      setViewerMicEnabled(next)
      setError(null)
      setStatus(
        next ? '폰 마이크 켜짐 — 송출 태블릿에서 들려요' : '폰 마이크 꺼짐',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [viewerMicEnabled])

  const allowRemotePlayback = useCallback(() => {
    void roomRef.current?.startAudio()
    setStatus('소리 재생을 허용했어요')
  }, [])

  const connect = useCallback(async () => {
    manualDisconnectRef.current = false
    clearReconnectTimer()
    setError(null)
    setConnecting(true)
    setConnBadge('connecting')
    setStatus('토큰 요청 중…')
    let r: Room | null = null
    try {
      const publishLabel =
        role === 'publish' ? SLOT_LABELS[publishSlot] : undefined
      const tokenName =
        role === 'publish'
          ? displayName.trim()
            ? `${publishLabel} (${displayName.trim()})`
            : publishLabel
          : displayName.trim() || undefined

      const { token, url } = await fetchToken({
        room: ROOM_NAME,
        identity,
        role,
        name: tokenName,
      })
      r = new Room(createRoomOptions(role))
      roomRef.current = r

      r.on(RoomEvent.Reconnecting, () => {
        setConnBadge('reconnecting')
        setStatus('네트워크가 불안정해 재연결 중…')
      })
      r.on(RoomEvent.Reconnected, () => {
        setConnBadge('live')
        setReconnectAttempt(0)
        setStatus('재연결 완료')
      })
      r.on(RoomEvent.Disconnected, () => {
        setConnected(false)
        if (manualDisconnectRef.current) {
          setConnBadge('offline')
          setStatus('연결 종료')
          return
        }
        setConnBadge('reconnecting')
        if (hasEverConnectedRef.current) {
          scheduleReconnect()
        } else {
          setStatus('연결 실패')
        }
      })

      setStatus('룸 연결 중…')
      await r.connect(url, token)

      if (role === 'publish') {
        await r.localParticipant.setCameraEnabled(true)
        await r.localParticipant.setMicrophoneEnabled(true)
        setPublishMicEnabled(true)
        setStatus('카메라·마이크 준비됨')
      } else {
        await r.localParticipant.setCameraEnabled(false)
        await r.localParticipant.setMicrophoneEnabled(false)
        setViewerMicEnabled(false)
        setStatus('시청 준비됨')
      }

      void r.startAudio().catch(() => {})

      /** ref(비디오 영역)는 `connected === true` 일 때만 DOM에 있음 → 먼저 화면 전환 */
      setConnected(true)
      hasEverConnectedRef.current = true
      setConnBadge('live')
      setReconnectAttempt(0)
    } catch (e) {
      if (r) await r.disconnect()
      roomRef.current = null
      setError(e instanceof Error ? e.message : String(e))
      setStatus('')
      setConnected(false)
      setConnBadge('error')
      if (!manualDisconnectRef.current && hasEverConnectedRef.current) {
        scheduleReconnect()
      }
    } finally {
      setConnecting(false)
    }
  }, [displayName, identity, publishSlot, role, clearReconnectTimer, scheduleReconnect])

  useEffect(() => {
    connectRef.current = () => connect()
  }, [connect])

  /** 연결 후 DOM이 생긴 뒤 트랙 붙이기 (이전 버그: ref 없이 return 해서 화면이 안 바뀜) */
  useEffect(() => {
    if (!connected) return
    const r = roomRef.current
    if (!r) return

    const remoteContainer = remoteWrapRef.current
    const audioSink = remoteAudioSinkRef.current
    if (!remoteContainer) return

    const attachRemoteTrack = (track: Track, participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Video) return
      const wrap = document.createElement('div')
      wrap.className = 'remote-tile'
      wrap.dataset.participantId = participant.identity
      const head = document.createElement('div')
      head.className = 'remote-tile-head'
      const labelEl = document.createElement('div')
      labelEl.className = 'remote-tile-label'
      const pname = participant.name?.trim() || participant.identity
      labelEl.textContent = pname
      if (pname.includes('큰방') || isLivingRoomRemoteLabel(pname)) {
        const liveDot = document.createElement('span')
        liveDot.className = 'remote-live-dot'
        liveDot.setAttribute('aria-label', '송출 중')
        liveDot.title = '송출 중'
        labelEl.appendChild(liveDot)
      }
      const stage = document.createElement('div')
      stage.className = 'remote-tile-stage'
      const fsBtn = document.createElement('button')
      fsBtn.type = 'button'
      fsBtn.className = 'btn ghost btn-small remote-tile-fs-btn'
      fsBtn.textContent = '전체화면'
      fsBtn.setAttribute('aria-label', `${pname} 영상만 전체 화면`)
      const el = track.attach()
      if (el instanceof HTMLVideoElement) {
        el.playsInline = true
        el.muted = false
        const applyStageRatioFromVideo = () => {
          const w = el.videoWidth
          const h = el.videoHeight
          if (w > 0 && h > 0) {
            stage.style.aspectRatio = `${w} / ${h}`
          }
        }
        el.addEventListener('loadedmetadata', applyStageRatioFromVideo)
        if (el.readyState >= 1) applyStageRatioFromVideo()
        void el.play().catch(() => {
          /* iOS는 제스처 후 재생될 수 있음 */
        })
      }
      el.className = 'remote-video-el'
      if (el instanceof HTMLVideoElement) {
        el.style.objectFit = fitMode
      }
      if (isLivingRoomRemoteLabel(pname)) {
        el.classList.add('remote-video-el--mirror')
      }
      fsBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        e.preventDefault()
        if (isVideoEl(el)) {
          enterTilePseudoFullscreen(el, pname)
        }
      })
      fsBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
      const camRow = document.createElement('div')
      camRow.className = 'remote-tile-cam-row'
      ;(
        [
          ['front', '전면'],
          ['back', '후면'],
          ['ultra', '광각'],
        ] as const
      ).forEach(([mode, label]) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'btn ghost btn-small remote-tile-cam-btn'
        b.textContent = label
        b.setAttribute('aria-label', `${pname} ${label}`)
        b.addEventListener('click', (e) => {
          e.stopPropagation()
          e.preventDefault()
          void sendViewerCameraCommand(mode, participant.identity)
        })
        b.addEventListener('pointerdown', (e) => e.stopPropagation())
        camRow.appendChild(b)
      })
      stage.appendChild(fsBtn)
      stage.appendChild(el)
      wrap.dataset.viewerOrder = String(viewerStreamOrder(pname))
      head.appendChild(labelEl)
      head.appendChild(camRow)
      wrap.appendChild(head)
      wrap.appendChild(stage)
      const prev = remoteContainer.querySelector<HTMLElement>(
        `.remote-tile[data-participant-id="${participant.identity}"]`,
      )
      if (prev) prev.remove()
      remoteContainer.appendChild(wrap)
      sortViewerRemoteTiles(remoteContainer)
    }

    const attachRemoteAudio = (track: Track) => {
      if (track.kind !== Track.Kind.Audio) return
      const sink = audioSink ?? document.body
      const el = track.attach()
      el.autoplay = true
      sink.appendChild(el)
      void el.play().catch(() => {
        /* 브라우저 자동재생 정책 — 「소리 재생」 버튼으로 startAudio */
      })
    }

    const onTrackSubscribed = (
      track: Track,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (publication.source === Track.Source.Camera && track.kind === Track.Kind.Video) {
        attachRemoteTrack(track, participant)
        return
      }
      if (
        publication.source === Track.Source.Microphone &&
        track.kind === Track.Kind.Audio
      ) {
        attachRemoteAudio(track)
      }
    }
    const onTrackUnsubscribed = (track: Track) => {
      const detached = track.detach()
      detached.forEach((e) => {
        let node: Element | null = e
        while (node && !node.classList.contains('remote-tile')) {
          node = node.parentElement
        }
        if (node) {
          node.remove()
        } else {
          e.remove()
        }
      })
    }

    r.remoteParticipants.forEach((p) => {
      p.trackPublications.forEach((pub) => {
        if (!pub.track) return
        if (pub.kind === Track.Kind.Video && pub.source === Track.Source.Camera) {
          attachRemoteTrack(pub.track, p)
        }
        if (pub.kind === Track.Kind.Audio && pub.source === Track.Source.Microphone) {
          attachRemoteAudio(pub.track)
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
      setStatus('카메라·마이크 송출 중')
    } else {
      setStatus('시청 중')
    }

    const gridEl = remoteContainer

    const syncTileFullscreenButtons = () => {
      gridEl.querySelectorAll<HTMLButtonElement>('.remote-tile-fs-btn').forEach((btn) => {
        const st = btn.closest('.remote-tile-stage')
        if (!st) return
        const fsEl = document.fullscreenElement
        const inside =
          !!fsEl && (fsEl === st || (fsEl !== btn && st.contains(fsEl)))
        btn.textContent = inside ? '전체화면 끝' : '전체화면'
      })
      // 일부 브라우저(iOS 포함)는 fullscreen 토글 후 비디오가 pause 될 수 있어 재생을 다시 시도
      gridEl.querySelectorAll<HTMLVideoElement>('video').forEach((v) => {
        void v.play().catch(() => {})
      })
      void r.startAudio().catch(() => {})
    }
    document.addEventListener('fullscreenchange', syncTileFullscreenButtons)
    document.addEventListener('webkitfullscreenchange', syncTileFullscreenButtons)

    return () => {
      document.removeEventListener('fullscreenchange', syncTileFullscreenButtons)
      document.removeEventListener('webkitfullscreenchange', syncTileFullscreenButtons)
      r.off(RoomEvent.TrackSubscribed, onTrackSubscribed)
      r.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
      r.off(RoomEvent.LocalTrackPublished, onLocalPublished)
      gridEl.innerHTML = ''
      audioSink?.replaceChildren()
      exitTilePseudoFullscreen()
    }
  }, [
    connected,
    role,
    exitTilePseudoFullscreen,
    enterTilePseudoFullscreen,
    fitMode,
    sendViewerCameraCommand,
  ])

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

  /** 시청 영상: 기준점 탭 · 핀치(중심 기준 확대) · 확대 시 드래그 이동 · Ctrl+휠 */
  useEffect(() => {
    const el = remoteZoomWrapRef.current
    if (!el || !connected || role !== 'view') return

    const clientToFocusPct = (clientX: number, clientY: number) => {
      const rect = el.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return null
      return {
        x: Math.max(4, Math.min(96, ((clientX - rect.left) / rect.width) * 100)),
        y: Math.max(4, Math.min(96, ((clientY - rect.top) / rect.height) * 100)),
      }
    }

    const clampPan = (x: number, y: number) => {
      const z = remoteZoomRef.current
      const rect = el.getBoundingClientRect()
      const limX = Math.max(48, rect.width * (z - 1) * 0.52)
      const limY = Math.max(48, rect.height * (z - 1) * 0.52)
      return {
        x: Math.max(-limX, Math.min(limX, x)),
        y: Math.max(-limY, Math.min(limY, y)),
      }
    }

    let pinchBaseD = 0
    let pinchBaseZ = 1
    let touchPhase: 'idle' | 'maybe-tap' | 'pan' | 'pinch' = 'idle'
    let panStartClient = { x: 0, y: 0 }
    let panOrigin = { x: 0, y: 0 }

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const p = clientToFocusPct(e.clientX, e.clientY)
      if (p) setRemoteFocusPct(p)
      setRemoteZoom((z) => clampRemoteZoom(z + e.deltaY * -0.01))
    }

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        touchPhase = 'pinch'
        const [a, b] = [e.touches[0], e.touches[1]]
        const midX = (a.clientX + b.clientX) / 2
        const midY = (a.clientY + b.clientY) / 2
        const p = clientToFocusPct(midX, midY)
        if (p) setRemoteFocusPct(p)
        pinchBaseD = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        pinchBaseZ = remoteZoomRef.current
      } else if (e.touches.length === 1) {
        touchPhase = 'maybe-tap'
        panStartClient = { x: e.touches[0].clientX, y: e.touches[0].clientY }
        panOrigin = { ...remotePanRef.current }
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && touchPhase === 'pinch' && pinchBaseD > 0) {
        e.preventDefault()
        const [a, b] = [e.touches[0], e.touches[1]]
        const midX = (a.clientX + b.clientX) / 2
        const midY = (a.clientY + b.clientY) / 2
        const p = clientToFocusPct(midX, midY)
        if (p) setRemoteFocusPct(p)
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        setRemoteZoom(clampRemoteZoom(pinchBaseZ * (d / pinchBaseD)))
        return
      }
      if (e.touches.length === 1 && remoteZoomRef.current > 1.02) {
        const t = e.touches[0]
        const dx = t.clientX - panStartClient.x
        const dy = t.clientY - panStartClient.y
        if (touchPhase === 'maybe-tap' && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
          touchPhase = 'pan'
        }
        if (touchPhase === 'pan') {
          e.preventDefault()
          setRemotePan(clampPan(panOrigin.x + dx, panOrigin.y + dy))
        }
      }
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (touchPhase === 'maybe-tap' && e.changedTouches.length >= 1) {
        const t = e.changedTouches[0]
        const dx = t.clientX - panStartClient.x
        const dy = t.clientY - panStartClient.y
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
          const p = clientToFocusPct(t.clientX, t.clientY)
          if (p) setRemoteFocusPct(p)
        }
      }
      if (e.touches.length === 0) {
        touchPhase = 'idle'
        pinchBaseD = 0
      } else if (e.touches.length === 1 && touchPhase === 'pinch') {
        touchPhase = 'maybe-tap'
        panStartClient = { x: e.touches[0].clientX, y: e.touches[0].clientY }
        panOrigin = { ...remotePanRef.current }
      }
    }

    let mouseDown = false
    let mousePanning = false
    let mouseStart = { x: 0, y: 0 }
    let mousePanOrigin = { x: 0, y: 0 }

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      mouseDown = true
      mousePanning = false
      mouseStart = { x: e.clientX, y: e.clientY }
      mousePanOrigin = { ...remotePanRef.current }
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!mouseDown || remoteZoomRef.current <= 1.02) return
      const dx = e.clientX - mouseStart.x
      const dy = e.clientY - mouseStart.y
      if (!mousePanning && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        mousePanning = true
      }
      if (mousePanning) {
        setRemotePan(clampPan(mousePanOrigin.x + dx, mousePanOrigin.y + dy))
      }
    }

    const onMouseUp = (e: MouseEvent) => {
      if (!mouseDown) return
      const dx = e.clientX - mouseStart.x
      const dy = e.clientY - mouseStart.y
      if (!mousePanning && Math.abs(dx) < 6 && Math.abs(dy) < 6) {
        const p = clientToFocusPct(e.clientX, e.clientY)
        if (p) setRemoteFocusPct(p)
      }
      mouseDown = false
      mousePanning = false
    }

    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('touchstart', onTouchStart, { passive: false })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    el.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)

    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      el.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [connected, role])

  return (
    <div
      className={`app ${connected && role === 'publish' ? 'app--publish' : ''} ${connected && role === 'view' ? 'app--view' : ''}`}
    >
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
        <section className="form form-card form-card--landing">
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

          {role === 'view' && (
            <p className="landing-view-hint">
              연결 후 <strong>전체 화면</strong>으로 켜면 가로로 넓게 보기 좋아요.
            </p>
          )}

          {role === 'publish' && (
            <fieldset className="role-field slot-field">
              <legend>송출 위치</legend>
              <label>
                <input
                  type="radio"
                  name="publishSlot"
                  checked={publishSlot === '1'}
                  onChange={() => setPublishSlot('1')}
                />{' '}
                {SLOT_LABELS['1']}
              </label>
              <label>
                <input
                  type="radio"
                  name="publishSlot"
                  checked={publishSlot === '2'}
                  onChange={() => setPublishSlot('2')}
                />{' '}
                {SLOT_LABELS['2']}
              </label>
            </fieldset>
          )}

          {role === 'view' && (
            <div className="viewer-name-presets-wrap">
              <span className="viewer-name-presets-title">시청자 선택 (필수)</span>
              <div className="viewer-name-presets" role="group" aria-label="시청자 선택">
              <button
                type="button"
                className={`btn btn-small ${displayName.trim() === '다혜' ? 'btn-toggle-active' : 'ghost'}`}
                onClick={() => setDisplayName('다혜')}
              >
                다혜
              </button>
              <button
                type="button"
                className={`btn btn-small ${displayName.trim() === '동현' ? 'btn-toggle-active' : 'ghost'}`}
                onClick={() => setDisplayName('동현')}
              >
                동현
              </button>
              </div>
            </div>
          )}

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
          <div ref={remoteAudioSinkRef} className="remote-audio-sink" aria-hidden />
          <div className="session-card">
            <div className="session-bar">
              <span className="pill">{role === 'publish' ? '송출 중' : '시청 중'}</span>
              {role === 'publish' ? (
                <>
                  <span className="room-label">방 · {ROOM_NAME}</span>
                  <span className={`status status--${connBadge}`}>
                    {status || (connBadge === 'live' ? '연결 안정' : '대기')}
                    {connBadge === 'reconnecting' && reconnectAttempt > 0
                      ? ` · 재시도 ${reconnectAttempt}`
                      : ''}
                  </span>
                </>
              ) : (
                <div className="viewer-presence-tabs" aria-label="현재 시청자 상태">
                  <span className={`viewer-tab ${viewerPresence.dahye ? 'is-on' : 'is-off'}`}>
                    <span className="dot" />
                    다혜
                  </span>
                  <span className={`viewer-tab ${viewerPresence.donghyun ? 'is-on' : 'is-off'}`}>
                    <span className="dot" />
                    동현
                  </span>
                </div>
              )}
              {role === 'publish' && (
                <button type="button" className="btn ghost" onClick={() => void disconnect()}>
                  나가기
                </button>
              )}
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
                <span className="badge">
                  미리보기 · {SLOT_LABELS[publishSlot]}
                </span>
                <div ref={localZoomWrapRef} className="zoom-frame zoom-frame--local">
                  <div
                    className="zoom-inner zoom-inner--local"
                    style={{ transform: `scale(${localZoom})` }}
                  >
                    <video
                      ref={localVideoRef}
                      className={`local-video local-video--publish ${
                        publishSlot === '2' ? 'local-video--mirror' : ''
                      }`}
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
                <div className="mic-row">
                  <button
                    type="button"
                    className={`btn btn-small ${publishMicEnabled ? 'ghost' : 'record-active'}`}
                    onClick={() => void togglePublishMic()}
                  >
                    {publishMicEnabled ? '마이크 끄기' : '마이크 켜기'}
                  </button>
                  <span className="mic-row-hint">
                    켜 두면 폰·다른 태블릿에서 소리로 들려요. 거실 화면 좌우는 시청 쪽에서만 맞춰요.
                  </span>
                </div>
                <div className="record-row">
                  <button
                    type="button"
                    className={`btn btn-small ${isRecording ? 'record-active' : 'ghost'}`}
                    onClick={() => void toggleLocalRecording()}
                  >
                    {isRecording ? '녹화 중지' : '녹화 시작'}
                  </button>
                  <button
                    type="button"
                    className="btn ghost btn-small"
                    onClick={captureLocalPreview}
                  >
                    캡쳐
                  </button>
                  {isRecording && recordRemainingSec !== null ? (
                    <span className="record-remaining" aria-live="polite">
                      {formatSec2(recordRemainingSec)}
                    </span>
                  ) : (
                    <span className="record-hint">녹화 후 공유창에서 사진 앱 저장</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {role === 'view' ? (
            <div ref={viewerImmersiveRef} className="viewer-immersive-wrap">
              <div ref={tileOverlayRef} className="tile-pseudo-fs-overlay" />
              <div className="viewer-immersive-toolbar">
                <button
                  type="button"
                  className="btn ghost btn-small"
                  onClick={() => void allowRemotePlayback()}
                >
                  소리 재생
                </button>
                <button
                  type="button"
                  className={`btn btn-small ${viewerMicEnabled ? 'record-active' : 'ghost'}`}
                  onClick={() => void toggleViewerMic()}
                >
                  {viewerMicEnabled ? '폰 마이크 끄기' : '폰 마이크 켜기'}
                </button>
                <button
                  type="button"
                  className={`btn btn-small ${isViewerRecording ? 'record-active' : 'ghost'}`}
                  onClick={() => void toggleViewerRecording()}
                >
                  {isViewerRecording ? '녹화 중지' : '녹화 시작'}
                </button>
                <button type="button" className="btn ghost btn-small" onClick={captureRemoteView}>
                  캡쳐
                </button>
                {isViewerRecording && viewerRecordRemainingSec !== null && (
                  <span className="record-remaining" aria-live="polite">
                    {formatSec2(viewerRecordRemainingSec)}
                  </span>
                )}
              </div>
              <div
                ref={remoteZoomWrapRef}
                className="zoom-frame zoom-frame--remote zoom-frame--remote-active zoom-frame--viewer-gestures"
              >
                <div
                  className="zoom-inner-pan zoom-inner-pan--remote"
                  style={{ transform: `translate(${remotePan.x}px, ${remotePan.y}px)` }}
                >
                  <div
                    className="zoom-inner zoom-inner--remote"
                    style={{
                      transform: `scale(${remoteZoom})`,
                      transformOrigin: `${remoteFocusPct.x}% ${remoteFocusPct.y}%`,
                    }}
                  >
                    <div className="remote-grid" ref={remoteWrapRef} />
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div ref={remoteZoomWrapRef} className="zoom-frame zoom-frame--remote">
              <div
                className="zoom-inner zoom-inner--remote"
                style={{ transform: `scale(${remoteZoom})` }}
              >
                <div className="remote-grid" ref={remoteWrapRef} />
              </div>
            </div>
          )}

          {role === 'view' && (
            <>
              <p className="viewer-empty-hint">
                영상이 없으면 큰방·거실 송출 태블릿에서 연결을 켜 주세요.
              </p>
            </>
          )}
        </section>
      )}
      {savedPreview && (
        <div className="saved-preview-overlay" role="dialog" aria-modal="true" aria-label="저장 미리보기">
          <div className="saved-preview-card">
            <div className="saved-preview-head">
              <strong>저장 미리보기</strong>
              <div className="saved-preview-actions">
                <button type="button" className="btn ghost btn-small" onClick={() => void shareSavedPreview()}>
                  공유하기
                </button>
                <button type="button" className="btn ghost btn-small" onClick={closeSavedPreview}>
                  닫기
                </button>
              </div>
            </div>
            <p className="saved-preview-hint">
              {savedPreview.mimeType.startsWith('image/')
                ? '이미지를 길게 눌러 사진 앱에 저장해 주세요.'
                : '영상을 재생한 뒤 공유 메뉴에서 저장해 주세요.'}
            </p>
            <div className="saved-preview-body">
              {savedPreview.mimeType.startsWith('image/') ? (
                <img src={savedPreview.url} alt={savedPreview.fileName} className="saved-preview-image" />
              ) : (
                <video
                  src={savedPreview.url}
                  className="saved-preview-video"
                  controls
                  playsInline
                  preload="metadata"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
