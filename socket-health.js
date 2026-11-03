const Token = require('./Token')
const logger = require('./Logging')
const {
  socketHealth,
  socketCutReasons,
  socketEvents,
  USER_ROOM_PREFIX,
} = require('./SocketConstants')

const CLOSED_TRANSPORT_STATES = ['closing', 'closed']

// The handshake validates the token only once. After that the socket lives on its own: it can hang
// (the client stops draining what we send), break (the transport closed but we still hold it) or
// expire (the token ran out). This module tracks that state and cuts the socket when needed.
const registry = new Map()

let io
let reaperTimer = null

const attach = (socketServer) => {
  io = socketServer
}

const reset = () => {
  registry.clear()
}

const expiresAtOf = (socket) =>
  socket.decoded && socket.decoded.exp ? socket.decoded.exp * 1000 : null

const register = (socket) => {
  const entry = registry.get(socket.id) || {
    connectedAt: Date.now(),
    backlogSince: null,
  }

  entry.expiresAt = expiresAtOf(socket)
  entry.expiryWarned = false

  registry.set(socket.id, entry)
  return entry
}

const unregister = (socketId) => registry.delete(socketId)

const size = () => registry.size

const getSocket = (socketId) =>
  io && socketId ? io.sockets.sockets.get(socketId) : undefined

const isBroken = (socket) =>
  !socket.conn || CLOSED_TRANSPORT_STATES.includes(socket.conn.readyState)

const isExpired = (entry, now) =>
  entry.expiresAt !== null && now >= entry.expiresAt

// The engine.io buffer only empties while the transport is writable. If the client stopped
// reading it grows forever. We measure how long it has gone without draining instead of its size,
// because a legitimate burst (a gospel section is sent in batches) fills it for an instant too.
const observeBacklog = (socket, entry, now) => {
  if (!socket.conn || !socket.conn.writeBuffer.length) {
    entry.backlogSince = null
    return 0
  }

  if (entry.backlogSince === null) {
    entry.backlogSince = now
  }

  return now - entry.backlogSince
}

const isStalled = (socket, entry, now) =>
  observeBacklog(socket, entry, now) > socketHealth.maxBacklogStallMs

const notify = (socket, message) => {
  try {
    socket.emit(socketEvents.message, message)
  } catch (error) {
    logger.error(`Failed to notify socket ${socket.id}: ${error.message}`)
  }
}

const cut = (socket, reason) => {
  logger.info(`Cutting socket ${socket.id}: ${reason}`)

  notify(socket, { type: socketEvents.disconnecting, reason })

  // engine.io defers the close until the 'drain' event when the buffer holds anything, and on a
  // hung socket that drain never arrives. Emptying it is what makes the cut effective.
  if (socket.conn) {
    socket.conn.writeBuffer.length = 0
    if (socket.conn.packetsFn) {
      socket.conn.packetsFn.length = 0
    }
  }

  socket.disconnect(true)
}

const cutReasonFor = (socket, entry, now) => {
  if (isBroken(socket)) {
    return socketCutReasons.transportBroken
  }

  if (isStalled(socket, entry, now)) {
    return socketCutReasons.deliveryStalled
  }

  if (
    entry.expiresAt !== null &&
    now >= entry.expiresAt + socketHealth.tokenRefreshGraceMs
  ) {
    return socketCutReasons.tokenExpired
  }

  return null
}

const warnExpiringToken = (socket, entry, now) => {
  if (entry.expiryWarned || entry.expiresAt === null) {
    return
  }

  if (now < entry.expiresAt - socketHealth.tokenExpiryWarningMs) {
    return
  }

  entry.expiryWarned = true
  notify(socket, {
    type: socketEvents.tokenExpiring,
    expiresAt: entry.expiresAt,
  })
}

const refreshToken = (socket, token) => {
  if (!token) {
    notify(socket, { type: socketEvents.tokenRefreshed, success: false })
    return false
  }

  try {
    socket.decoded = Token.verify(token)
  } catch (error) {
    logger.info(
      `Socket ${socket.id} sent an invalid token on refresh: ${error.message}`
    )
    notify(socket, { type: socketEvents.tokenRefreshed, success: false })
    return false
  }

  register(socket)
  notify(socket, { type: socketEvents.tokenRefreshed, success: true })
  return true
}

// Single source of truth for senders: tells whether it is worth spending queries and memory on
// this socket before starting and between batches.
const isDeliverable = (socketId, now = Date.now()) => {
  const socket = getSocket(socketId)

  if (!socket) {
    return false
  }

  const entry = registry.get(socketId) || register(socket)

  return (
    !isBroken(socket) && !isExpired(entry, now) && !isStalled(socket, entry, now)
  )
}

const userRoomOf = (userId) => `${USER_ROOM_PREFIX}${userId}`

// Every socket joins the room of its user on connect, which is enough to close the session on all
// of that user's tabs.
const cutUserSockets = (userId, reason = socketCutReasons.sessionClosed) => {
  if (!io || !userId) {
    return 0
  }

  const socketIds = io.sockets.adapter.rooms.get(userRoomOf(userId))

  if (!socketIds) {
    return 0
  }

  let cutCount = 0

  for (const socketId of [...socketIds]) {
    const socket = getSocket(socketId)

    if (socket) {
      try {
        cut(socket, reason)
        cutCount += 1
      } catch (error) {
        logger.error(
          `Failed to cut socket ${socketId} of user ${userId}: ${error.message}`
        )
      }
    }

    registry.delete(socketId)
  }

  return cutCount
}

const sweepSocket = (socketId, entry, now) => {
  const socket = getSocket(socketId)

  if (!socket) {
    registry.delete(socketId)
    return
  }

  try {
    const reason = cutReasonFor(socket, entry, now)

    if (reason) {
      cut(socket, reason)
      registry.delete(socketId)
      return
    }

    warnExpiringToken(socket, entry, now)
  } catch (error) {
    logger.error(`Failed to evaluate socket ${socketId}: ${error.message}`)
    registry.delete(socketId)
  }
}

const sweep = (now = Date.now()) => {
  if (!io) {
    return
  }

  for (const [socketId, entry] of registry) {
    sweepSocket(socketId, entry, now)
  }
}

const startReaper = () => {
  if (reaperTimer) {
    return
  }

  logger.info(`Starting the socket reaper every ${socketHealth.sweepIntervalMs}ms`)
  reaperTimer = setInterval(() => sweep(), socketHealth.sweepIntervalMs)
}

const stopReaper = () => {
  if (!reaperTimer) {
    return
  }

  clearInterval(reaperTimer)
  reaperTimer = null
}

module.exports = {
  attach,
  reset,
  register,
  unregister,
  refreshToken,
  cutUserSockets,
  userRoomOf,
  isDeliverable,
  sweep,
  startReaper,
  stopReaper,
  size,
}
