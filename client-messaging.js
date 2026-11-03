const { Server } = require('socket.io')
const Token = require('./Token')
const logger = require('./Logging')
const socketHealth = require('./socket-health')
const {
  socketHealth: socketHealthConfig,
  socketEvents,
} = require('./SocketConstants')

const AUTHENTICATION_ERROR = 'AuthenticationError'

let io

const tokenOf = (socket) => socket.handshake.auth && socket.handshake.auth.token

const authenticate = (socket, next) => {
  const token = tokenOf(socket)

  if (!token) {
    return next(new Error(AUTHENTICATION_ERROR))
  }

  try {
    socket.decoded = Token.verify(token)
  } catch (error) {
    return next(new Error(AUTHENTICATION_ERROR))
  }

  return next()
}

const onConnection = (socket) => {
  logger.info(`Connected to socket ${socket.id}`)
  socketHealth.register(socket)
  socket.join(socketHealth.userRoomOf(socket.decoded.id))

  // The handshake token expires while the socket stays open. Instead of cutting the user off
  // mid-session we warn beforehand (socketEvents.tokenExpiring) and they renew it through here.
  socket.on(socketEvents.refreshToken, (token) => {
    socketHealth.refreshToken(socket, token)
  })

  socket.on('disconnect', () => {
    logger.info(`Disconnected ${socket.id}`)
    socketHealth.unregister(socket.id)
  })

  socket.on('error', (error) => {
    logger.error(`Error ${socket.id}: ${error.message}`)
  })
}

const websocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: { origin: '*' },
    pingInterval: socketHealthConfig.pingIntervalMs,
    pingTimeout: socketHealthConfig.pingTimeoutMs,
  })

  socketHealth.attach(io)
  socketHealth.startReaper()

  io.use(authenticate).on('connection', onConnection)

  return io
}

const close = async () => {
  socketHealth.stopReaper()
  socketHealth.reset()

  if (io) {
    await io.close()
    io = undefined
  }
}

// io.to(<dead socket>) does not fail: it emits into the void. Without this check the sender
// believes it delivered.
const sendTo = (socketId, event, payload) => {
  if (!io || !socketId) {
    return false
  }

  if (!socketHealth.isDeliverable(socketId)) {
    logger.info(
      `Dropping "${event}" for socket ${socketId}: the client is no longer deliverable`
    )
    return false
  }

  io.to(socketId).emit(event, payload)
  return true
}

// Emits to every connected socket that is still worth writing to, so a hung client does not
// keep accumulating buffered events. Returns how many sockets it reached.
const broadcast = (event, payload) => {
  if (!io) {
    return 0
  }

  let deliveredCount = 0

  for (const socketId of io.sockets.sockets.keys()) {
    if (sendTo(socketId, event, payload)) {
      deliveredCount += 1
    }
  }

  return deliveredCount
}

module.exports = {
  websocket,
  close,
  sendTo,
  broadcast,
  isDeliverable: socketHealth.isDeliverable,
  cutUserSockets: socketHealth.cutUserSockets,
}
