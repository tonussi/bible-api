const dotenv = require('dotenv')
const jwt = require('jsonwebtoken')

dotenv.config()

const JWT_SECRET = process.env.JWT_SECRET || 'secret'
const JWT_EXPIRATION = process.env.JWT_EXPIRATION || '24h'

const sign = (payload) =>
  jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRATION })

const verify = (token) => jwt.verify(token, JWT_SECRET)

module.exports = { sign, verify }
