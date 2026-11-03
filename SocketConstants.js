const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS

const socketHealth = {
  pingIntervalMs: 25 * SECOND_MS,
  pingTimeoutMs: 20 * SECOND_MS,
  sweepIntervalMs: 15 * SECOND_MS,
  maxBacklogStallMs: 30 * SECOND_MS,
  tokenExpiryWarningMs: 5 * MINUTE_MS,
  tokenRefreshGraceMs: 2 * MINUTE_MS,
}

const socketCutReasons = {
  transportBroken: 'transport-broken',
  deliveryStalled: 'delivery-stalled',
  tokenExpired: 'token-expired',
  sessionClosed: 'session-closed',
}

const socketEvents = {
  message: 'message',
  disconnecting: 'disconnecting',
  tokenExpiring: 'token-expiring',
  tokenRefreshed: 'token-refreshed',
  refreshToken: 'refresh-token',
}

const USER_ROOM_PREFIX = 'user:'

module.exports = {
  socketHealth,
  socketCutReasons,
  socketEvents,
  USER_ROOM_PREFIX,
}
