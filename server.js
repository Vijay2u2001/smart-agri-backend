const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
  }
});

// Enhanced CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Add pre-flight OPTIONS handler
app.options('*', cors());

// In-memory databases
let sensorData = {};
let historicalData = {};
let waterUsage = {};
let pendingCommands = {};

const devicePlantMap = {
  esp32_1: 'lettuce',
  esp32_2: 'spinach'
};

// Improved logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Enhanced root endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: '🌱 Smart Agriculture Backend',
    version: '1.0.0',
    endpoints: {
      update: 'POST /update',
      data: 'GET /data',
      sensorData: 'GET /sensor-data/:plantType',
      historicalData: 'GET /historical-data/:plantType'
    }
  });
});

app.get('/connect', (req, res) => {
  res.json({ status: 'connected', timestamp: new Date().toISOString() });
});

// Enhanced update endpoint with better error handling
app.post('/update', (req, res) => {
  try {
    const { deviceId, data } = req.body;

    if (!deviceId || !data) {
      console.error('Missing deviceId or data', req.body);
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['deviceId', 'data'],
        received: Object.keys(req.body)
      });
    }

    // Validate device ID
    if (!devicePlantMap[deviceId]) {
      console.warn(`Unknown device ID: ${deviceId}`);
    }

    // Store latest data
    sensorData[deviceId] = data;

    // Historical storage
    const plantType = devicePlantMap[deviceId] || 'unknown';
    const timestamped = { ...data, timestamp: new Date().toISOString() };

    if (!historicalData[plantType]) {
      historicalData[plantType] = [];
    }
    historicalData[plantType].push(timestamped);
    
    // Keep only last 100 records
    if (historicalData[plantType].length > 100) {
      historicalData[plantType].shift();
    }

    // Water usage tracking
    if (data.fertilizer_level !== undefined) {
      const today = new Date().toISOString().split('T')[0];
      if (!waterUsage[today]) {
        waterUsage[today] = {
          startLevel: data.fertilizer_level,
          currentLevel: data.fertilizer_level,
          usage: 0
        };
      } else {
        waterUsage[today].currentLevel = data.fertilizer_level;
        const tankSize = 100; // Adjust to your actual tank size
        waterUsage[today].usage =
          (waterUsage[today].startLevel - waterUsage[today].currentLevel) * tankSize / 100;
      }
    }

    // Emit update via WebSocket
    io.emit('dataUpdate', { deviceId, data });
    
    res.json({ 
      status: 'success',
      deviceId,
      receivedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error in /update:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// ... (keep other endpoints the same)

// Enhanced server startup
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Endpoints:`);
  console.log(`- http://localhost:${PORT}/`);
  console.log(`- http://localhost:${PORT}/update`);
});

// Handle unhandled rejections
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});
