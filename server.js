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
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Add pre-flight OPTIONS handler
app.options('*', cors());

// Constants
const COMMAND_TYPES = {
  LIGHT_ON: 'light_on',
  LIGHT_OFF: 'light_off',
  WATER_PLANT: 'water_plant',
  ADD_NUTRIENTS: 'add_nutrients',
  // Added ESP32 specific commands
  WATER_PUMP: 'water_pump',
  FERT_PUMP: 'fert_pump',
  LED: 'led'
};

const COMMAND_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMEOUT: 'timeout'
};

// In-memory databases
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
    light: false,
    lastWatered: null,
    lastNutrients: null,
    lastUpdated: new Date().toISOString()
  };
});

// Improved logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  if (req.method === 'POST' && req.body) {
    console.log('Request Body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// Enhanced root endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: '🌱 Smart Agriculture Backend',
    version: '2.1.0',
    endpoints: {
      update: 'POST /update',
      data: 'GET /data',
      sensorData: 'GET /sensor-data/:plantType',
      historicalData: 'GET /historical-data/:plantType',
      sendCommand: 'POST /send-command',
      getCommands: 'GET /get-commands/:deviceId', // Added this endpoint
      commandStatus: 'GET /command-status/:deviceId',
      deviceState: 'GET /device-state/:deviceId'
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    devices: Object.keys(deviceStates).length,
    pendingCommands: Object.keys(pendingCommands).reduce((acc, key) => acc + pendingCommands[key].length, 0)
  });
});

// New endpoint for ESP32 to fetch commands
app.get('/get-commands/:deviceId', (req, res) => {
  try {
    const { deviceId } = req.params;
    
    if (!deviceId) {
      return res.status(400).json({ 
        error: 'Device ID is required'
      });
    }

    const commands = pendingCommands[deviceId] || [];
    const pending = commands.filter(c => c.status === COMMAND_STATUS.PENDING);
    
    // Mark commands as completed as we're sending them
    pending.forEach(c => {
      c.status = COMMAND_STATUS.COMPLETED;
      c.completedAt = new Date().toISOString();
    });

    // Format commands for ESP32
    const formattedCommands = pending.map(c => ({
      command: c.command,
      value: c.command === COMMAND_TYPES.LIGHT_ON || 
             c.command === COMMAND_TYPES.WATER_PUMP ||
             c.command === COMMAND_TYPES.FERT_PUMP ||
             c.command === COMMAND_TYPES.LED ? 1 : 0,
      duration: c.duration || 3000
    }));

    res.json(formattedCommands);
    
    // Notify via WebSocket
    if (pending.length > 0) {
      io.emit('commandsProcessed', { deviceId, commands: pending });
    }
  } catch (error) {
    console.error('Error in /get-commands:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Enhanced update endpoint with better error handling
app.post('/update', (req, res) => {
  try {
    console.log('Received update request:', req.body); // Detailed logging
    
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
    console.log(`Updated sensor data for ${deviceId}`);

    // Update device state
    if (data.ledStatus !== undefined) {
      deviceStates[deviceId].light = data.ledStatus;
    }
    deviceStates[deviceId].lastUpdated = new Date().toISOString();

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
    console.error('Error in /update:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Command endpoints
app.post('/send-command', (req, res) => {
  try {
    const { deviceId, command, value, duration } = req.body;
    
    if (!deviceId || !command) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['deviceId', 'command'],
        optional: ['value', 'duration']
      });
    }

    // Create command object
    const commandObj = {
      id: Date.now().toString(),
      command,
      value: value || (command === COMMAND_TYPES.LIGHT_ON || 
                      command === COMMAND_TYPES.WATER_PUMP || 
                      command === COMMAND_TYPES.FERT_PUMP || 
                      command === COMMAND_TYPES.LED ? 1 : 0),
      deviceId,
      duration: duration || 3000, // default 3 seconds
      timestamp: new Date().toISOString(),
      status: COMMAND_STATUS.PENDING
    };

    // Store command
    if (!pendingCommands[deviceId]) {
      pendingCommands[deviceId] = [];
    }
    pendingCommands[deviceId].push(commandObj);

    // Update device state (predictive)
    if (command === COMMAND_TYPES.LIGHT_ON || command === COMMAND_TYPES.LED) {
      deviceStates[deviceId].light = true;
    } else if (command === COMMAND_TYPES.LIGHT_OFF) {
      deviceStates[deviceId].light = false;
    } else if (command === COMMAND_TYPES.WATER_PLANT || command === COMMAND_TYPES.WATER_PUMP) {
      deviceStates[deviceId].lastWatered = new Date().toISOString();
    } else if (command === COMMAND_TYPES.ADD_NUTRIENTS || command === COMMAND_TYPES.FERT_PUMP) {
      deviceStates[deviceId].lastNutrients = new Date().toISOString();
    }

    // Broadcast via WebSocket
    io.emit('commandIssued', commandObj);
    
    // Set timeout for command (5 minutes)
    setTimeout(() => {
      const cmdIndex = pendingCommands[deviceId].findIndex(c => c.id === commandObj.id);
      if (cmdIndex !== -1 && pendingCommands[deviceId][cmdIndex].status === COMMAND_STATUS.PENDING) {
        pendingCommands[deviceId][cmdIndex].status = COMMAND_STATUS.TIMEOUT;
        io.emit('commandTimeout', pendingCommands[deviceId][cmdIndex]);
      }
    }, 5 * 60 * 1000); // 5 minutes
    
    res.json({
      status: 'success',
      message: 'Command received and queued',
      command: commandObj
    });

  } catch (error) {
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// ... [Keep all other existing endpoints the same] ...

// WebSocket connection handler
io.on('connection', (socket) => {
  console.log('📡 Client connected via WebSocket');
  
  // Send initial state
  socket.emit('init', { 
    sensorData, 
    deviceStates,
    pendingCommands 
  });

  // Handle command requests from frontend
  socket.on('requestCommand', (data) => {
    const { deviceId, command, value, duration } = data;
    
    if (!deviceId || !command) {
      return socket.emit('commandError', { error: 'Missing deviceId or command' });
    }

    // Broadcast to all clients (including Arduino if connected)
    io.emit('newCommand', { 
      deviceId, 
      command,
      value,
      duration: duration || 3000 
    });
  });

  socket.on('disconnect', () => {
    console.log('❌ Client disconnected');
  });
});

// Cleanup old commands periodically
setInterval(() => {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  
  Object.keys(pendingCommands).forEach(deviceId => {
    pendingCommands[deviceId] = pendingCommands[deviceId].filter(command => {
      const commandTime = new Date(command.timestamp);
      return commandTime > oneHourAgo || command.status === COMMAND_STATUS.PENDING;
    });
  });
}, 30 * 60 * 1000); // Run every 30 minutes

// Enhanced server startup
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Endpoints:`);
  console.log(`- http://localhost:${PORT}/`);
  console.log(`- http://localhost:${PORT}/update`);
  console.log(`- http://localhost:${PORT}/send-command`);
  console.log(`- http://localhost:${PORT}/get-commands/:deviceId`); // Added this
  console.log(`- ws://localhost:${PORT} (WebSocket)`);
});

// Handle unhandled rejections
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});
