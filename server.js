const fs = require('fs')
const http = require('http')
const cors = require('cors')
const express = require('express')
const logger = require('./Logging')
const swaggerUi = require('swagger-ui-express')
const {
  ProcessingInstruction,
  ProcessingSegments,
  ProcessingSegmentsAsync,
} = require('./index')
const { createBullBoard } = require('@bull-board/api')
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter')
const { ExpressAdapter } = require('@bull-board/express')
const {
  segmentsQueue,
  computeStatisticsQueue,
  segmentsQueueEvents,
  addComputeStatisticsJob,
  computeStatisticsQueueEvents,
} = require('./workers')
const { register, login, authenticateToken, refreshToken } = require('./Auth')
const { websocket, broadcast } = require('./client-messaging')

const app = express()
const server = http.createServer(app)
websocket(server)

const port = process.env.PORT || 3001

segmentsQueueEvents.on('completed', ({ jobId, returnvalue }) => {
  try {
    const parsedResult =
      typeof returnvalue === 'string' ? JSON.parse(returnvalue) : returnvalue
    broadcast('process-completed', { jobId, result: parsedResult })
  } catch (err) {
    logger.error(
      `Error parsing process-completed result for job ${jobId}: ${err.message}`
    )
    broadcast('process-completed', { jobId, result: returnvalue })
  } finally {
    broadcast('finish', { jobId })
  }
})

segmentsQueueEvents.on('failed', ({ jobId, failedReason }) => {
  broadcast('process-failed', { jobId, error: failedReason })
  broadcast('finish', { jobId })
})

computeStatisticsQueueEvents.on('completed', ({ jobId, returnvalue }) => {
  try {
    const parsedResult =
      typeof returnvalue === 'string' ? JSON.parse(returnvalue) : returnvalue
    broadcast('compute-statistics-completed', { jobId, result: parsedResult })
  } catch (err) {
    logger.error(
      `Error parsing compute-statistics-completed result for job ${jobId}: ${err.message}`
    )
    broadcast('compute-statistics-completed', { jobId, result: returnvalue })
  } finally {
    broadcast('finish', { jobId })
  }
})

computeStatisticsQueueEvents.on('failed', ({ jobId, failedReason }) => {
  broadcast('compute-statistics-failed', { jobId, error: failedReason })
  broadcast('finish', { jobId })
})

app.use(cors())
app.use(express.json())

// Load generated swagger file
const swaggerFile = './swagger-output.json'
if (fs.existsSync(swaggerFile)) {
  const swaggerDocs = JSON.parse(fs.readFileSync(swaggerFile, 'utf-8'))
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs))
} else {
  console.warn('Swagger file not found. Run "node swagger.js" first.')
}

// BullMQ Dashboard
const serverAdapter = new ExpressAdapter()
serverAdapter.setBasePath('/admin/queues')

createBullBoard({
  queues: [
    new BullMQAdapter(segmentsQueue),
    new BullMQAdapter(computeStatisticsQueue),
  ],
  serverAdapter: serverAdapter,
})

app.use('/admin/queues', serverAdapter.getRouter())

app.post('/api/auth/register', async (req, res) => {
  /*
    #swagger.tags = ['Auth']
    #swagger.security = []
    #swagger.parameters['body'] = {
      in: 'body',
      description: 'Register a new user',
      schema: {
        username: 'user',
        password: 'password'
      }
    }
  */
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' })
  }
  try {
    const user = register(username, password)
    res.status(201).json({ message: 'User registered successfully', user })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/auth/login', async (req, res) => {
  /*
    #swagger.tags = ['Auth']
    #swagger.security = []
    #swagger.parameters['body'] = {
      in: 'body',
      description: 'Login to get a JWT',
      schema: {
        username: 'user',
        password: 'password'
      }
    }
  */
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' })
  }
  try {
    const result = login(username, password)
    res.json(result)
  } catch (err) {
    res.status(401).json({ error: err.message })
  }
})

app.post('/api/auth/refresh', authenticateToken, (req, res) => {
  /*
    #swagger.tags = ['Auth']
    #swagger.security = [{ "bearerAuth": [] }]
  */
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]
  try {
    const result = refreshToken(token)
    res.json(result)
  } catch (err) {
    res.status(403).json({ error: 'Could not refresh token' })
  }
})

app.get('/api/health', (req, res) => {
  res.status(200);
})

app.post('/api/process', authenticateToken, async (req, res) => {
  /* 
    #swagger.security = [{ "bearerAuth": [] }]
    #swagger.parameters['body'] = {
      in: 'body',
      description: 'Process a Bible command or segments',
      schema: { 
        type: 'object',
        properties: {
          segments: { 
            type: 'array',
            items: {
              type: 'object',
              properties: {
                book: { type: 'number' },
                chapter: { type: 'number' },
                from: { type: 'number' },
                to: { type: 'number' },
                publisher: { type: 'string' }
              }
            }
          },
          message: { type: 'string' }
        }
      }
    }
    #swagger.responses[200] = {
      description: 'Success',
      schema: { $ref: '#/definitions/ProcessResponse' }
    }
  */
  const { segments } = req.body
  logger.info(`Processing request: ${segments}`)
  try {
    if (segments && Array.isArray(segments)) {
      const result = await ProcessingSegmentsAsync(segments)
      if (result.error) {
        return res.status(400).json(result)
      }
      return res.json(result)
    }

    return res.status(400).json({ error: 'Segments (array) are required' })
  } catch (error) {
    console.error(error)
    res
      .status(500)
      .json({ error: 'Internal Server Error', details: error.message })
  }
})

app.post('/api/compute-statistics', authenticateToken, async (req, res) => {
  /*
    #swagger.security = [{ "bearerAuth": [] }]
    #swagger.parameters['body'] = {
      in: 'body',
      description: 'Compute word-sequence statistics for gospel sections',
      schema: {
        type: 'object',
        properties: {
          verses: { type: 'array' },
          minLength: { type: 'number' },
          mode: { type: 'string' },
          similarityThreshold: { type: 'number' }
        }
      }
    }
    #swagger.responses[200] = {
      description: 'Job queued',
      schema: { jobId: 'string', status: 'queued' }
    }
  */
  const { verses, minLength, mode, similarityThreshold } = req.body
  logger.info(
    `Compute statistics request: ${verses?.length || 0} sections, mode=${mode}`
  )
  try {
    if (!verses || !Array.isArray(verses)) {
      return res.status(400).json({ error: 'verses (array) is required' })
    }
    const job = await addComputeStatisticsJob({
      verses,
      minLength,
      mode,
      similarityThreshold,
    })
    return res.json({ jobId: job.id, status: 'queued' })
  } catch (error) {
    console.error(error)
    res
      .status(500)
      .json({ error: 'Internal Server Error', details: error.message })
  }
})

server.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`)
  console.log(`Swagger docs available at http://localhost:${port}/api-docs`)
  console.log(
    `BullMQ dashboard available at http://localhost:${port}/admin/queues`
  )
})
