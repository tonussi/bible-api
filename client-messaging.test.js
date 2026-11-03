const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { io: connectClient } = require('socket.io-client')

process.env.JWT_SECRET = 'client-messaging-test-secret'

const Token = require('./Token')
const socketHealth = require('./socket-health')
const clientMessaging = require('./client-messaging')
const { socketCutReasons, socketEvents } = require('./SocketConstants')

const USER_ID = 7
const OTHER_USER_ID = 8
const EVENT_TIMEOUT_MS = 2000

const waitForEvent = (socket, event) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${event}"`)),
      EVENT_TIMEOUT_MS
    )
    socket.once(event, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })

describe('client-messaging', () => {
  let httpServer
  let url
  const clients = []

  const connect = async (auth) => {
    const client = connectClient(url, {
      auth,
      transports: ['websocket'],
      reconnection: false,
    })
    clients.push(client)
    await Promise.race([
      waitForEvent(client, 'connect'),
      waitForEvent(client, 'connect_error').then((error) => {
        throw error
      }),
    ])
    return client
  }

  const connectAs = (userId) =>
    connect({ token: Token.sign({ id: userId, username: `user-${userId}` }) })

  before(async () => {
    httpServer = http.createServer()
    clientMessaging.websocket(httpServer)
    await new Promise((resolve) => httpServer.listen(0, resolve))
    url = `http://localhost:${httpServer.address().port}`
  })

  after(async () => {
    clients.forEach((client) => client.close())
    await clientMessaging.close()
    await new Promise((resolve) => httpServer.close(resolve))
  })

  describe('handshake', () => {
    it('rejects a connection without a token', async () => {
      await assert.rejects(connect({}), { message: 'AuthenticationError' })
    })

    it('rejects a connection with an invalid token', async () => {
      await assert.rejects(connect({ token: 'garbage' }), {
        message: 'AuthenticationError',
      })
    })

    it('accepts a connection with a valid token and tracks it', async () => {
      const before = socketHealth.size()

      await connectAs(USER_ID)

      assert.equal(socketHealth.size(), before + 1)
    })
  })

  describe('delivery', () => {
    it('broadcasts an event to every connected client', async () => {
      const first = await connectAs(USER_ID)
      const second = await connectAs(OTHER_USER_ID)
      const firstReceived = waitForEvent(first, 'process-completed')
      const secondReceived = waitForEvent(second, 'process-completed')

      const deliveredCount = clientMessaging.broadcast('process-completed', {
        jobId: '1',
      })

      assert.ok(deliveredCount >= 2)
      assert.deepEqual(await firstReceived, { jobId: '1' })
      assert.deepEqual(await secondReceived, { jobId: '1' })
    })

    it('sends an event only to the requested socket', async () => {
      const target = await connectAs(USER_ID)
      const bystander = await connectAs(USER_ID)
      const received = waitForEvent(target, 'process-completed')
      let bystanderReceived = false
      bystander.on('process-completed', () => {
        bystanderReceived = true
      })

      const delivered = clientMessaging.sendTo(target.id, 'process-completed', {
        jobId: '2',
      })

      assert.equal(delivered, true)
      assert.deepEqual(await received, { jobId: '2' })
      assert.equal(bystanderReceived, false)
    })

    it('does not deliver to a socket that is gone', () => {
      assert.equal(
        clientMessaging.sendTo('ghost', 'process-completed', {}),
        false
      )
    })
  })

  describe('token refresh', () => {
    it('answers a valid refresh with success', async () => {
      const client = await connectAs(USER_ID)
      const answer = waitForEvent(client, socketEvents.message)

      client.emit(
        socketEvents.refreshToken,
        Token.sign({ id: USER_ID, username: 'user-7' })
      )

      assert.deepEqual(await answer, {
        type: socketEvents.tokenRefreshed,
        success: true,
      })
    })

    it('answers an invalid refresh with failure', async () => {
      const client = await connectAs(USER_ID)
      const answer = waitForEvent(client, socketEvents.message)

      client.emit(socketEvents.refreshToken, 'garbage')

      assert.deepEqual(await answer, {
        type: socketEvents.tokenRefreshed,
        success: false,
      })
    })
  })

  describe('closing a user session', () => {
    it('cuts every socket of that user and leaves the others alone', async () => {
      const userTab = await connectAs(USER_ID + 100)
      const otherUserTab = await connectAs(OTHER_USER_ID + 100)
      const notice = waitForEvent(userTab, socketEvents.message)
      const disconnected = waitForEvent(userTab, 'disconnect')

      const cutCount = clientMessaging.cutUserSockets(USER_ID + 100)

      assert.equal(cutCount, 1)
      assert.deepEqual(await notice, {
        type: socketEvents.disconnecting,
        reason: socketCutReasons.sessionClosed,
      })
      await disconnected
      assert.equal(otherUserTab.connected, true)
    })
  })
})
