const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')

process.env.JWT_SECRET = 'socket-health-test-secret'

const socketHealth = require('./socket-health')
const {
  socketHealth: config,
  socketCutReasons,
  socketEvents,
} = require('./SocketConstants')

const NOW = 1_700_000_000_000
const SECONDS = 1000

const makeSocket = ({ id = 'socket-1', expiresAtMs = null } = {}) => {
  const emitted = []
  return {
    id,
    decoded: expiresAtMs ? { id: 7, exp: expiresAtMs / SECONDS } : { id: 7 },
    conn: { readyState: 'open', writeBuffer: [], packetsFn: [] },
    emitted,
    disconnected: false,
    emit(event, message) {
      emitted.push({ event, message })
    },
    disconnect() {
      this.disconnected = true
    },
  }
}

const makeIo = (sockets, rooms = {}) => ({
  sockets: {
    sockets: new Map(sockets.map((socket) => [socket.id, socket])),
    adapter: {
      rooms: new Map(
        Object.entries(rooms).map(([room, ids]) => [room, new Set(ids)])
      ),
    },
  },
})

const messagesOfType = (socket, type) =>
  socket.emitted.filter(({ message }) => message.type === type)

describe('socket-health', () => {
  beforeEach(() => {
    socketHealth.stopReaper()
    socketHealth.reset()
  })

  describe('sweep', () => {
    it('keeps a healthy socket', () => {
      const socket = makeSocket()
      socketHealth.attach(makeIo([socket]))
      socketHealth.register(socket)

      socketHealth.sweep(NOW)

      assert.equal(socket.disconnected, false)
      assert.equal(socketHealth.size(), 1)
    })

    it('cuts a socket whose transport is closed', () => {
      const socket = makeSocket()
      socket.conn.readyState = 'closed'
      socketHealth.attach(makeIo([socket]))
      socketHealth.register(socket)

      socketHealth.sweep(NOW)

      assert.equal(socket.disconnected, true)
      assert.equal(
        messagesOfType(socket, socketEvents.disconnecting)[0].message.reason,
        socketCutReasons.transportBroken
      )
      assert.equal(socketHealth.size(), 0)
    })

    it('cuts a socket whose backlog does not drain, and empties the buffer so the close is effective', () => {
      const socket = makeSocket()
      socket.conn.writeBuffer.push('packet')
      socket.conn.packetsFn.push(() => {})
      socketHealth.attach(makeIo([socket]))
      socketHealth.register(socket)

      socketHealth.sweep(NOW)
      assert.equal(socket.disconnected, false)

      socketHealth.sweep(NOW + config.maxBacklogStallMs + 1)

      assert.equal(socket.disconnected, true)
      assert.equal(socket.conn.writeBuffer.length, 0)
      assert.equal(socket.conn.packetsFn.length, 0)
      assert.equal(
        messagesOfType(socket, socketEvents.disconnecting)[0].message.reason,
        socketCutReasons.deliveryStalled
      )
    })

    it('forgives a backlog that drains before the stall limit', () => {
      const socket = makeSocket()
      socket.conn.writeBuffer.push('packet')
      socketHealth.attach(makeIo([socket]))
      socketHealth.register(socket)

      socketHealth.sweep(NOW)
      socket.conn.writeBuffer.length = 0
      socketHealth.sweep(NOW + config.maxBacklogStallMs - 1)
      socket.conn.writeBuffer.push('packet')
      socketHealth.sweep(NOW + config.maxBacklogStallMs + 1)

      assert.equal(socket.disconnected, false)
    })

    it('warns once when the token is about to expire', () => {
      const expiresAtMs = NOW + config.tokenExpiryWarningMs
      const socket = makeSocket({ expiresAtMs })
      socketHealth.attach(makeIo([socket]))
      socketHealth.register(socket)

      socketHealth.sweep(NOW)
      socketHealth.sweep(NOW + SECONDS)

      const warnings = messagesOfType(socket, socketEvents.tokenExpiring)
      assert.equal(warnings.length, 1)
      assert.equal(warnings[0].message.expiresAt, expiresAtMs)
      assert.equal(socket.disconnected, false)
    })

    it('does not warn while the token has plenty of life left', () => {
      const socket = makeSocket({
        expiresAtMs: NOW + config.tokenExpiryWarningMs + 60 * SECONDS,
      })
      socketHealth.attach(makeIo([socket]))
      socketHealth.register(socket)

      socketHealth.sweep(NOW)

      assert.equal(messagesOfType(socket, socketEvents.tokenExpiring).length, 0)
    })

    it('cuts an expired token only after the refresh grace period', () => {
      const expiresAtMs = NOW
      const socket = makeSocket({ expiresAtMs })
      socketHealth.attach(makeIo([socket]))
      socketHealth.register(socket)

      socketHealth.sweep(expiresAtMs + config.tokenRefreshGraceMs - 1)
      assert.equal(socket.disconnected, false)

      socketHealth.sweep(expiresAtMs + config.tokenRefreshGraceMs)

      assert.equal(socket.disconnected, true)
      assert.equal(
        messagesOfType(socket, socketEvents.disconnecting)[0].message.reason,
        socketCutReasons.tokenExpired
      )
    })

    it('forgets sockets that are no longer connected', () => {
      const socket = makeSocket()
      socketHealth.attach(makeIo([]))
      socketHealth.register(socket)

      socketHealth.sweep(NOW)

      assert.equal(socketHealth.size(), 0)
    })
  })

  describe('refreshToken', () => {
    const signToken = (options) =>
      jwt.sign({ id: 7 }, process.env.JWT_SECRET, options)

    it('accepts a valid token, extends the lifetime and clears the warning', () => {
      const socket = makeSocket({ expiresAtMs: NOW })
      socketHealth.attach(makeIo([socket]))
      socketHealth.register(socket)
      socketHealth.sweep(NOW)

      const refreshed = socketHealth.refreshToken(
        socket,
        signToken({ expiresIn: '1h' })
      )

      assert.equal(refreshed, true)
      assert.equal(
        messagesOfType(socket, socketEvents.tokenRefreshed).at(-1).message
          .success,
        true
      )
      socketHealth.sweep(NOW + config.tokenRefreshGraceMs + SECONDS)
      assert.equal(socket.disconnected, false)
    })

    it('rejects an invalid token and keeps the current session', () => {
      const socket = makeSocket()
      socketHealth.attach(makeIo([socket]))
      socketHealth.register(socket)

      const refreshed = socketHealth.refreshToken(socket, 'not-a-token')

      assert.equal(refreshed, false)
      assert.equal(
        messagesOfType(socket, socketEvents.tokenRefreshed)[0].message.success,
        false
      )
      assert.equal(socket.disconnected, false)
    })

    it('rejects a missing token', () => {
      const socket = makeSocket()
      socketHealth.attach(makeIo([socket]))
      socketHealth.register(socket)

      assert.equal(socketHealth.refreshToken(socket, undefined), false)
    })
  })

  describe('isDeliverable', () => {
    it('is true for a healthy socket', () => {
      const socket = makeSocket()
      socketHealth.attach(makeIo([socket]))

      assert.equal(socketHealth.isDeliverable(socket.id, NOW), true)
    })

    it('is false for an unknown socket', () => {
      socketHealth.attach(makeIo([]))

      assert.equal(socketHealth.isDeliverable('ghost', NOW), false)
    })

    it('is false for a broken transport', () => {
      const socket = makeSocket()
      socket.conn.readyState = 'closing'
      socketHealth.attach(makeIo([socket]))

      assert.equal(socketHealth.isDeliverable(socket.id, NOW), false)
    })

    it('is false for an expired token', () => {
      const socket = makeSocket({ expiresAtMs: NOW - 1 })
      socketHealth.attach(makeIo([socket]))

      assert.equal(socketHealth.isDeliverable(socket.id, NOW), false)
    })

    it('is false once the backlog has been stalled for too long', () => {
      const socket = makeSocket()
      socket.conn.writeBuffer.push('packet')
      socketHealth.attach(makeIo([socket]))

      assert.equal(socketHealth.isDeliverable(socket.id, NOW), true)
      assert.equal(
        socketHealth.isDeliverable(socket.id, NOW + config.maxBacklogStallMs + 1),
        false
      )
    })
  })

  describe('cutUserSockets', () => {
    it('cuts every socket in the user room and reports how many', () => {
      const first = makeSocket({ id: 'a' })
      const second = makeSocket({ id: 'b' })
      const other = makeSocket({ id: 'c' })
      socketHealth.attach(
        makeIo([first, second, other], { 'user:7': ['a', 'b'] })
      )
      ;[first, second, other].forEach(socketHealth.register)

      const cutCount = socketHealth.cutUserSockets(7)

      assert.equal(cutCount, 2)
      assert.equal(first.disconnected, true)
      assert.equal(second.disconnected, true)
      assert.equal(other.disconnected, false)
      assert.equal(
        messagesOfType(first, socketEvents.disconnecting)[0].message.reason,
        socketCutReasons.sessionClosed
      )
    })

    it('returns zero when the user has no sockets', () => {
      socketHealth.attach(makeIo([]))

      assert.equal(socketHealth.cutUserSockets(99), 0)
    })

    it('returns zero without a user id', () => {
      socketHealth.attach(makeIo([]))

      assert.equal(socketHealth.cutUserSockets(undefined), 0)
    })
  })

  describe('reaper', () => {
    it('starts once and stops cleanly', () => {
      socketHealth.attach(makeIo([]))

      socketHealth.startReaper()
      socketHealth.startReaper()
      socketHealth.stopReaper()
      socketHealth.stopReaper()
    })
  })
})
