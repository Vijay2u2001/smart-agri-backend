const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Enhanced Socket.IO configuration
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  }
});

// Enhanced CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Add pre-flight OPTIONS handler
app.options('*', cors());

// In-memory databases with initialization
let sensorData = {};
let historicalData = {};
let waterUsage = {};
let pendingCommands = {};
let deviceStates = {};

const devicePlantMap = {
  esp32_1: 'lettuce',
  esp32_2: 'spinach'
};

// Initialize device states
Object.keys(devicePlantMap).forEach(deviceId => {
  deviceStates[deviceId] = {
    connected: false,
    lastSeen: null,
    light: false,
    pump: false,
    lastWatered: null,
    lastUpdated: new Date().toISOString()
  };
});

// Enhanced logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  if (req.method === 'POST' && req.body) {
    console.log('Request Body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// API Documentation Endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: '🌱 Smart Agriculture Backend',
    version: '1.1.0',
    endpoints: {
      update: 'POST /update',
      data: 'GET /data',
      sensorData: 'GET /sensor-data/:plantType',
      historicalData: 'GET /historical-data/:plantType',
      sendCommand: 'POST /send-command',
      getCommands: 'GET /get-commands/:deviceId',
      deviceStatus: 'GET /device-status/:deviceId',
      connect: 'GET /connect'
    }
  });
});

// Connection test endpoint
app.get('/connect', (req, res) => {
  res.json({ 
    status: 'connected', 
    timestamp: new Date().toISOString(),
    devices: Object.keys(deviceStates).map(id => ({
      id,
      connected: deviceStates[id].connected,
      lastSeen: deviceStates[id].lastSeen
    }))
  });
});

// Device status endpoint
app.get('/device-status/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  if (!deviceStates[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }
  res.json(deviceStates[deviceId]);
});

// Command endpoints for Arduino
app.get('/get-commands/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  
  if (!deviceId) {
    return res.status(400).json({ error: 'Device ID is required' });
  }

  // Update device connection status
  deviceStates[deviceId].connected = true;
  deviceStates[deviceId].lastSeen = new Date().toISOString();

  // Get pending commands
  const commands = pendingCommands[deviceId] || [];
  const pending = commands.filter(cmd => cmd.status === 'pending');
  
  // Mark commands as completed
  pending.forEach(cmd => {
    cmd.status = 'completed';
    cmd.completedAt = new Date().toISOString();
  });

  res.json(pending);
});

// Enhanced update endpoint
app.post('/update', (req, res) => {
  try {
    const { deviceId, data } = req.body;

    if (!deviceId || !data) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['deviceId', 'data']
      });
    }

    // Update device connection status
    deviceStates[deviceId].connected = true;
    deviceStates[deviceId].lastSeen = new Date().toISOString();
    deviceStates[deviceId].lastUpdated = new Date().toISOString();

    // Store sensor data
    sensorData[deviceId] = data;

    // Historical data storage
    const plantType = devicePlantMap[deviceId] || 'unknown';
    const timestampedData = { 
      ...data, 
      timestamp: new Date().toISOString(),
      deviceId 
    };

    if (!historicalData[plantType]) {
      historicalData[plantType] = [];
    }
    historicalData[plantType].push(timestampedData);
    
    // Keep only last 100 records
    if (historicalData[plantType].length > 100) {
      historicalData[plantType] = historicalData[plantType].slice(-100);
    }

    // Water usage tracking
    if (data.water_level !== undefined) {
      const today = new Date().toISOString().split('T')[0];
      if (!waterUsage[today]) {
        waterUsage[today] = {
          startLevel: data.water_level,
          currentLevel: data.water_level,
          usage: 0
        };
      } else {
        waterUsage[today].currentLevel = data.water_level;
        waterUsage[today].usage = 
          waterUsage[today].startLevel - waterUsage[today].currentLevel;
      }
    }

    // Emit update via WebSocket
    io.emit('dataUpdate', { 
      deviceId, 
      data,
      state: deviceStates[deviceId]
    });
    
    res.json({ 
      status: 'success',
      deviceId,
      receivedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Command endpoint
app.post('/send-command', (req, res) => {
  try {
    const { deviceId, command, duration } = req.body;
    
    if (!deviceId || !command) {
      return res.status(400).json({ error: 'Missing deviceId or command' });
    }

    // Create command object
    const commandObj = {
      id: Date.now().toString(),
      deviceId,
      command,
      duration: duration || 3000, // default 3 seconds
      timestamp: new Date().toISOString(),
      status: 'pending'
    };

    // Store command
    if (!pendingCommands[deviceId]) {
      pendingCommands[deviceId] = [];
    }
    pendingCommands[deviceId].push(commandObj);

    // Update device state
    if (command === 'light_on') {
      deviceStates[deviceId].light = true;
    } else if (command === 'light_off') {
      deviceStates[deviceId].light = false;
    } else if (command === 'water_plant') {
      deviceStates[deviceId].lastWatered = new Date().toISOString();
    }

    // Broadcast via WebSocket
    io.emit('commandIssued', commandObj);
    
    res.json({ 
      status: 'success',
      command: commandObj
    });

  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// WebSocket connection handler
io.on('connection', (socket) => {
  console.log('Client connected via WebSocket:', socket.id);

  // Send initial state
  socket.emit('init', { 
    sensorData, 
    deviceStates,
    pendingCommands 
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });

  // Debug all events
  socket.onAny((event, ...args) => {
    console.log(`Socket event [${socket.id}]: ${event}`, args);
  });
});

// Cleanup old commands
setInterval(() => {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  
  Object.keys(pendingCommands).forEach(deviceId => {
    pendingCommands[deviceId] = pendingCommands[deviceId].filter(cmd => {
      return new Date(cmd.timestamp) > oneHourAgo || cmd.status === 'pending';
    });
  });

  // Mark disconnected devices
  Object.keys(deviceStates).forEach(deviceId => {
    if (deviceStates[deviceId].lastSeen && 
        new Date(deviceStates[deviceId].lastSeen) < oneHourAgo) {
      deviceStates[deviceId].connected = false;
    }
  });
}, 30 * 60 * 1000); // Every 30 minutes

// Start server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 HTTP endpoints:`);
  console.log(`- http://localhost:${PORT}/`);
  console.log(`- http://localhost:${PORT}/update`);
  console.log(`- http://localhost:${PORT}/send-command`);
  console.log(`- http://localhost:${PORT}/get-commands/:deviceId`);
  console.log(`⚡ WebSocket: ws://localhost:${PORT}`);
});
