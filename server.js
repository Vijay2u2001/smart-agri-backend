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
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  },
  pingInterval: 10000,
  pingTimeout: 5000,
  transports: ['websocket', 'polling']
});

// Enhanced CORS configuration
const corsOptions = {
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
};
app.use(cors(corsOptions));

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Add pre-flight OPTIONS handler
app.options('*', cors(corsOptions));

// Constants
const COMMAND_TYPES = {
  LIGHT_ON: 'light_on',
  LIGHT_OFF: 'light_off',
  WATER_PLANT: 'water_plant',
  ADD_NUTRIENTS: 'add_nutrients',
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

// In-memory databases with persistence
let sensorData = {};
let historicalData = {};
let pendingCommands = {};
let deviceStates = {};

const devicePlantMap = {
  esp32_1: 'lettuce',
  esp32_2: 'spinach'
};

// Initialize device states
const initializeDeviceStates = () => {
  Object.keys(devicePlantMap).forEach(deviceId => {
    if (!deviceStates[deviceId]) {
      deviceStates[deviceId] = {
        light: false,
        lastWatered: null,
        lastNutrients: null,
        lastUpdated: new Date().toISOString(),
        connectionStatus: 'disconnected',
        lastSeen: null
      };
    }
  });
};
initializeDeviceStates();

// Enhanced logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
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
    version: '2.2.0',
    endpoints: {
      update: 'POST /update',
      data: 'GET /data',
      sensorData: 'GET /sensor-data/:plantType',
      historicalData: 'GET /historical-data/:plantType',
      sendCommand: 'POST /send-command',
      getCommands: 'GET /get-commands/:deviceId',
      commandStatus: 'GET /command-status/:deviceId',
      deviceState: 'GET /device-state/:deviceId',
      health: 'GET /health',
      testEmit: 'GET /test-emit'
    }
  });
});

// Health check endpoint with more detailed information
app.get('/health', (req, res) => {
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(uptime / 60)} minutes ${Math.floor(uptime % 60)} seconds`,
    memoryUsage: {
      rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
    },
    connections: io.engine.clientsCount,
    devices: Object.keys(deviceStates).map(id => ({
      id,
      status: deviceStates[id].connectionStatus,
      lastSeen: deviceStates[id].lastSeen
    })),
    pendingCommands: Object.keys(pendingCommands).reduce((acc, key) => {
      acc[key] = pendingCommands[key].length;
      return acc;
    }, {})
  });
});

// Command Management Endpoints
app.get('/get-commands/:deviceId', (req, res) => {
  try {
    const { deviceId } = req.params;
    
    if (!deviceId) {
      return res.status(400).json({ 
        error: 'Device ID is required',
        received: req.params
      });
    }

    // Update device connection status
    deviceStates[deviceId] = deviceStates[deviceId] || {};
    deviceStates[deviceId].connectionStatus = 'connected';
    deviceStates[deviceId].lastSeen = new Date().toISOString();

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
      value: [COMMAND_TYPES.LIGHT_ON, COMMAND_TYPES.WATER_PUMP, 
              COMMAND_TYPES.FERT_PUMP, COMMAND_TYPES.LED].includes(c.command) ? 1 : 0,
      duration: c.duration || 3000
    }));

    console.log(`Sending ${formattedCommands.length} commands to ${deviceId}`);
    
    res.json(formattedCommands);
    
    // Notify via WebSocket
    if (pending.length > 0) {
      io.emit('commandsProcessed', { 
        deviceId, 
        commands: pending,
        timestamp: new Date().toISOString() 
      });
      console.log(`Emitted commandsProcessed for ${deviceId}`);
    }
  } catch (error) {
    console.error('Error in /get-commands:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Enhanced Data Update Endpoint
app.post('/update', (req, res) => {
  try {
    console.log('Raw update request body:', req.body);
    
    const { deviceId, data } = req.body;

    if (!deviceId || !data) {
      console.error('Missing deviceId or data', req.body);
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['deviceId', 'data'],
        received: Object.keys(req.body)
      });
    }

    // Initialize device state if not exists
    if (!deviceStates[deviceId]) {
      deviceStates[deviceId] = {
        light: false,
        lastWatered: null,
        lastNutrients: null,
        lastUpdated: new Date().toISOString(),
        connectionStatus: 'connected',
        lastSeen: new Date().toISOString()
      };
    } else {
      deviceStates[deviceId].connectionStatus = 'connected';
      deviceStates[deviceId].lastSeen = new Date().toISOString();
    }

    // Store latest data
    sensorData[deviceId] = {
      ...data,
      timestamp: new Date().toISOString()
    };

    // Update device state from sensor data
    if (data.ledStatus !== undefined) {
      deviceStates[deviceId].light = data.ledStatus;
    }
    deviceStates[deviceId].lastUpdated = new Date().toISOString();

    // Historical storage
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
    
    // Keep only last 100 records per plant type
    if (historicalData[plantType].length > 100) {
      historicalData[plantType] = historicalData[plantType].slice(-100);
    }

    // Prepare update data for emission
    const updateData = { 
      deviceId, 
      data: timestampedData, 
      state: deviceStates[deviceId] 
    };

    console.log('Emitting dataUpdate:', JSON.stringify(updateData, null, 2));
    
    // Emit to all connected clients
    io.emit('dataUpdate', updateData);
    
    // Emit to device-specific room
    io.to(deviceId).emit('deviceUpdate', updateData);
    
    res.json({ 
      status: 'success',
      deviceId,
      receivedAt: new Date().toISOString(),
      dataPoints: historicalData[plantType]?.length || 0
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

// Command Endpoint with Validation
app.post('/send-command', (req, res) => {
  try {
    const { deviceId, command, value, duration } = req.body;
    
    if (!deviceId || !command) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['deviceId', 'command'],
        optional: ['value', 'duration'],
        received: Object.keys(req.body)
      });
    }

    // Validate command type
    if (!Object.values(COMMAND_TYPES).includes(command)) {
      return res.status(400).json({
        error: 'Invalid command type',
        validCommands: Object.values(COMMAND_TYPES)
      });
    }

    // Create command object
    const commandObj = {
      id: Date.now().toString(),
      command,
      value: value !== undefined ? value : 
            [COMMAND_TYPES.LIGHT_ON, COMMAND_TYPES.WATER_PUMP, 
             COMMAND_TYPES.FERT_PUMP, COMMAND_TYPES.LED].includes(command) ? 1 : 0,
      deviceId,
      duration: duration || 3000,
      timestamp: new Date().toISOString(),
      status: COMMAND_STATUS.PENDING,
      issuedBy: req.ip
    };

    // Initialize command queue if not exists
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

    console.log(`New command queued for ${deviceId}:`, commandObj);
    
    // Broadcast via WebSocket
    io.emit('commandIssued', commandObj);
    
    // Set timeout for command (5 minutes)
    const timeout = setTimeout(() => {
      const cmdIndex = pendingCommands[deviceId].findIndex(c => c.id === commandObj.id);
      if (cmdIndex !== -1 && pendingCommands[deviceId][cmdIndex].status === COMMAND_STATUS.PENDING) {
        pendingCommands[deviceId][cmdIndex].status = COMMAND_STATUS.TIMEOUT;
        pendingCommands[deviceId][cmdIndex].timeoutAt = new Date().toISOString();
        io.emit('commandTimeout', pendingCommands[deviceId][cmdIndex]);
        console.log(`Command ${commandObj.id} timed out`);
      }
    }, 5 * 60 * 1000); // 5 minutes
    
    // Store timeout reference for cleanup
    commandObj.timeoutRef = timeout;
    
    res.json({
      status: 'success',
      message: 'Command received and queued',
      command: commandObj
    });

  } catch (error) {
    console.error('Error in /send-command:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Test WebSocket Emission Endpoint
app.get('/test-emit', (req, res) => {
  const testData = {
    message: 'Test message from server',
    timestamp: new Date().toISOString(),
    randomValue: Math.random()
  };
  
  io.emit('testEvent', testData);
  console.log('Test event emitted:', testData);
  
  res.json({
    status: 'success',
    message: 'Test event emitted to all connected clients',
    data: testData
  });
});

// Enhanced WebSocket Connection Handling
io.on('connection', (socket) => {
  const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  console.log(`📡 New client connected [${socket.id}] from ${clientIp}`);
  
  // Log all events from this socket
  socket.onAny((event, ...args) => {
    console.log(`[${socket.id}] Event: ${event}`, args);
  });

  // Join device-specific room if authenticated
  socket.on('authenticate', (deviceId) => {
    if (devicePlantMap[deviceId]) {
      socket.join(deviceId);
      console.log(`[${socket.id}] Joined device room: ${deviceId}`);
    }
  });

  // Send initial state to newly connected client
  const initData = { 
    sensorData, 
    deviceStates,
    pendingCommands: Object.keys(pendingCommands).reduce((acc, key) => {
      acc[key] = pendingCommands[key].filter(cmd => cmd.status === COMMAND_STATUS.PENDING);
      return acc;
    }, {}),
    timestamp: new Date().toISOString()
  };
  
  socket.emit('init', initData);
  console.log(`[${socket.id}] Sent init data`);

  // Handle command requests from frontend
  socket.on('requestCommand', (data) => {
    try {
      const { deviceId, command, value, duration } = data;
      
      if (!deviceId || !command) {
        return socket.emit('commandError', { 
          error: 'Missing deviceId or command',
          received: data
        });
      }

      // Broadcast to all clients
      io.emit('commandRequested', { 
        deviceId, 
        command,
        value,
        duration: duration || 3000,
        requestedBy: socket.id,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error(`[${socket.id}] Error in requestCommand:`, error);
      socket.emit('error', {
        message: 'Failed to process command request',
        error: error.message
      });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`❌ Client disconnected [${socket.id}]: ${reason}`);
  });

  socket.on('error', (error) => {
    console.error(`[${socket.id}] Socket error:`, error);
  });
});

// Cleanup old data periodically
setInterval(() => {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  
  // Cleanup pending commands
  Object.keys(pendingCommands).forEach(deviceId => {
    pendingCommands[deviceId] = pendingCommands[deviceId].filter(command => {
      const commandTime = new Date(command.timestamp);
      const shouldKeep = commandTime > oneHourAgo || command.status === COMMAND_STATUS.PENDING;
      
      // Clear timeout if command is being removed
      if (!shouldKeep && command.timeoutRef) {
        clearTimeout(command.timeoutRef);
      }
      
      return shouldKeep;
    });
  });
  
  // Update device connection status
  Object.keys(deviceStates).forEach(deviceId => {
    if (deviceStates[deviceId].lastSeen) {
      const lastSeen = new Date(deviceStates[deviceId].lastSeen);
      if (lastSeen < oneHourAgo) {
        deviceStates[deviceId].connectionStatus = 'disconnected';
      }
    }
  });
  
  console.log('Performed periodic cleanup');
}, 30 * 60 * 1000); // Run every 30 minutes

// Enhanced server startup
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 HTTP endpoints:`);
  console.log(`- http://localhost:${PORT}/`);
  console.log(`- http://localhost:${PORT}/update`);
  console.log(`- http://localhost:${PORT}/send-command`);
  console.log(`- http://localhost:${PORT}/get-commands/:deviceId`);
  console.log(`- http://localhost:${PORT}/test-emit`);
  console.log(`⚡ WebSocket endpoint: ws://localhost:${PORT}`);
});

// Handle process events
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
