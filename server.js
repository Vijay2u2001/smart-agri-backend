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
  ADD_NUTRIENTS: 'add_nutrients'
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
  next();
});

// Enhanced root endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: '🌱 Smart Agriculture Backend',
    version: '2.0.0',
    endpoints: {
      update: 'POST /update',
      data: 'GET /data',
      sensorData: 'GET /sensor-data/:plantType',
      historicalData: 'GET /historical-data/:plantType',
      sendCommand: 'POST /send-command',
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
    devices: Object.keys(deviceStates).length
  });
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

    // Update device state
    if (data.light_status !== undefined) {
      deviceStates[deviceId].light = data.light_status;
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
    io.emit('dataUpdate', { deviceId, data, state: deviceStates[deviceId] });
    
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

// Command endpoints
app.post('/send-command', (req, res) => {
  try {
    const { deviceId, command, duration } = req.body;
    
    if (!deviceId || !command) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['deviceId', 'command'],
        optional: ['duration']
      });
    }

    if (!Object.values(COMMAND_TYPES).includes(command)) {
      return res.status(400).json({ 
        error: 'Invalid command',
        validCommands: Object.values(COMMAND_TYPES)
      });
    }

    // Create command object
    const commandObj = {
      id: Date.now().toString(),
      command,
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
    if (command === COMMAND_TYPES.LIGHT_ON) {
      deviceStates[deviceId].light = true;
    } else if (command === COMMAND_TYPES.LIGHT_OFF) {
      deviceStates[deviceId].light = false;
    } else if (command === COMMAND_TYPES.WATER_PLANT) {
      deviceStates[deviceId].lastWatered = new Date().toISOString();
    } else if (command === COMMAND_TYPES.ADD_NUTRIENTS) {
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

app.get('/command-status/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const commands = pendingCommands[deviceId] || [];
  
  res.json({
    deviceId,
    pendingCommands: commands.filter(c => c.status === COMMAND_STATUS.PENDING),
    completedCommands: commands.filter(c => c.status === COMMAND_STATUS.COMPLETED),
    failedCommands: commands.filter(c => c.status === COMMAND_STATUS.FAILED || c.status === COMMAND_STATUS.TIMEOUT)
  });
});

app.get('/device-state/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  
  if (!deviceStates[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }
  
  res.json({
    deviceId,
    state: deviceStates[deviceId],
    lastUpdated: deviceStates[deviceId].lastUpdated
  });
});

app.post('/command-completed', (req, res) => {
  const { deviceId, commandId } = req.body;
  
  if (!pendingCommands[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const commandIndex = pendingCommands[deviceId].findIndex(c => c.id === commandId);
  if (commandIndex === -1) {
    return res.status(404).json({ error: 'Command not found' });
  }

  pendingCommands[deviceId][commandIndex].status = COMMAND_STATUS.COMPLETED;
  pendingCommands[deviceId][commandIndex].completedAt = new Date().toISOString();
  
  const completedCommand = pendingCommands[deviceId][commandIndex];
  
  // Update device state based on actual completion
  if (completedCommand.command === COMMAND_TYPES.WATER_PLANT) {
    deviceStates[deviceId].lastWatered = new Date().toISOString();
  } else if (completedCommand.command === COMMAND_TYPES.ADD_NUTRIENTS) {
    deviceStates[deviceId].lastNutrients = new Date().toISOString();
  }
  
  io.emit('commandCompleted', completedCommand);
  res.json({ status: 'success', command: completedCommand });
});

app.post('/command-failed', (req, res) => {
  const { deviceId, commandId, error } = req.body;
  
  if (!pendingCommands[deviceId]) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const commandIndex = pendingCommands[deviceId].findIndex(c => c.id === commandId);
  if (commandIndex === -1) {
    return res.status(404).json({ error: 'Command not found' });
  }

  pendingCommands[deviceId][commandIndex].status = COMMAND_STATUS.FAILED;
  pendingCommands[deviceId][commandIndex].error = error;
  pendingCommands[deviceId][commandIndex].completedAt = new Date().toISOString();
  
  const failedCommand = pendingCommands[deviceId][commandIndex];
  
  // Revert predictive state changes
  if (failedCommand.command === COMMAND_TYPES.LIGHT_ON) {
    deviceStates[deviceId].light = false;
  } else if (failedCommand.command === COMMAND_TYPES.LIGHT_OFF) {
    deviceStates[deviceId].light = true;
  }
  
  io.emit('commandFailed', failedCommand);
  res.json({ status: 'success', command: failedCommand });
});

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
    const { deviceId, command, duration } = data;
    
    if (!deviceId || !command) {
      return socket.emit('commandError', { error: 'Missing deviceId or command' });
    }

    if (!Object.values(COMMAND_TYPES).includes(command)) {
      return socket.emit('commandError', { 
        error: 'Invalid command',
        validCommands: Object.values(COMMAND_TYPES)
      });
    }

    // Broadcast to all clients (including Arduino if connected)
    io.emit('newCommand', { 
      deviceId, 
      command, 
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
