const bcrypt = require('bcryptjs')
const Database = require('better-sqlite3')
const path = require('path')
const Token = require('./Token')

const dbPath = path.resolve(__dirname, 'users.db')
const db = new Database(dbPath)

// Initialize users table
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`)

/**
 * Register a new user
 * @param {string} username 
 * @param {string} password 
 * @returns {object} The created user object
 */
const register = (username, password) => {
  const hashedPassword = bcrypt.hashSync(password, 10)
  const stmt = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)')
  try {
    const info = stmt.run(username, hashedPassword)
    return { id: info.lastInsertRowid, username }
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new Error('Username already exists')
    }
    throw err
  }
}

/**
 * Login a user and return a JWT
 * @param {string} username 
 * @param {string} password 
 * @returns {object} { token, user }
 */
const login = (username, password) => {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?')
  const user = stmt.get(username)
  if (!user || !bcrypt.compareSync(password, user.password)) {
    throw new Error('Invalid username or password')
  }
  const token = Token.sign({ id: user.id, username: user.username })
  return { token, user: { id: user.id, username: user.username } }
}

/**
 * Middleware to authenticate requests via JWT
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' })
  }

  try {
    const decoded = Token.verify(token)
    req.user = decoded
    next()
  } catch (err) {
    res.status(403).json({ error: 'Invalid or expired token.' })
  }
}

/**
 * Refresh a JWT — issues a new token with a fresh expiration
 * @param {string} token - The current (still-valid) JWT
 * @returns {object} { token }
 */
const refreshToken = (token) => {
  const { iat, exp, ...payload } = Token.verify(token)
  const newToken = Token.sign(payload)
  return { token: newToken }
}

module.exports = {
  register,
  login,
  authenticateToken,
  refreshToken
}
