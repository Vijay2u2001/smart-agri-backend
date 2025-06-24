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
    origin: [
      'https://smart-agriculture-box.netlify.app',
      'http://localhost:3000',
      'http://localhost:5173', // Vite dev server
    ],
    methods: ['GET', 'POST'],
    credentials: true,
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
  pingInterval: 10000,
  pingTimeout: 5000,
  transports: ['websocket', 'polling']
});

// Enhanced CORS configuration
const corsOptions = {
  origin: [
    'https://smart-agriculture-box.netlify.app',
    'http://localhost:3000',
    'http://localhost:5173',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
};
app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.options('*', cors(corsOptions));
app.enable('trust proxy');

// Constants
const COMMAND_TYPES = {
  LIGHT_ON: 'light_on',
  LIGHT_OFF: 'light_off',
  WATER_PLANT: 'water_plant',
  ADD_NUTRIENTS: 'add_nutrients',
  WATER_PUMP: 'water_pump',
  FERT_PUMP: 'fert_pump',
  LED: 'led',
  GROW_LIGHT: 'grow_light',
  NUTRIENT_PUMP: 'nutrient_pump'
};

const COMMAND_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMEOUT: 'timeout'
};

// In-memory data stores
let sensorData = {};
let historicalData = {};
let pendingCommands = {};
let deviceStates = {};

// Device to plant mapping
const devicePlantMap = {
  esp32_1: 'level1',
  esp32_2: 'level2'
};

// Initialize device states with proper structure
const initializeDeviceStates = () => {
  Object.keys(devicePlantMap).forEach(deviceId => {
    deviceStates[deviceId] = {
      light: false,
      waterPump: false,
      nutrientPump: false,
      lastWatered: null,
      lastNutrients: null,
      lastUpdated: new Date().toISOString(),
      connectionStatus: 'disconnected',
      lastSeen: null
    };
    
    // Initialize with sample data for testing
    sensorData[deviceId] = {
      temperature: 22 + Math.random() * 3,
      humidity: 60 + Math.random() * 10,
      moisture: 70 + Math.random() * 15,
      sunlight: 2500 + Math.random() * 1000,
      nitrogen: 40 + Math.random() * 10,
      phosphorus: 35 + Math.random() * 10,
      potassium: 45 + Math.random() * 10,
      waterLevel: 75,
      fertilizerLevel: 60,
      timestamp: new Date().toISOString(),
      deviceId
    };
  });

  // Initialize historical data
  Object.values(devicePlantMap).forEach(plantType => {
    historicalData[plantType] = [];
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
    version: '3.0.0',
    frontend: 'https://smart-agriculture-box.netlify.app',
    endpoints: {
      update: 'POST /update',
      data: 'GET /data',
      sensorData: 'GET /sensor-data/:plantType',
      historicalData: 'GET /historical-data/:plantType',
      sendCommand: 'POST /send-command',
      getCommands: 'GET /get-commands/:deviceId',
      deviceStatus: 'GET /device-status/:deviceId',
      health: 'GET /health',
      debug: {
        connections: '/debug/connections',
        data: '/debug/data',
        devices: '/debug/devices'
      }
    },
    devices: Object.keys(devicePlantMap),
    plantTypes: Object.values(devicePlantMap)
  });
});

// Health check endpoint
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
      lastSeen: deviceStates[id].lastSeen,
      plantType: devicePlantMap[id]
    })),
    pendingCommands: Object.keys(pendingCommands).reduce((acc, key) => {
      acc[key] = pendingCommands[key].length;
      return acc;
    }, {}),
    sensorData: Object.keys(sensorData).map(deviceId => ({
      deviceId,
      plantType: devicePlantMap[deviceId],
      lastUpdate: sensorData[deviceId]?.timestamp
    }))
  });
});

// Get sensor data for specific plant type
app.get('/sensor-data/:plantType', (req, res) => {
  try {
    const { plantType } = req.params;
    const deviceId = Object.keys(devicePlantMap).find(id => devicePlantMap[id] === plantType);
    
    if (!deviceId) {
      return res.status(404).json({ 
        error: 'Plant type not found',
        availableTypes: Object.values(devicePlantMap)
      });
    }
    
    const data = sensorData[deviceId];
    if (!data) {
      return res.status(404).json({ 
        error: 'No sensor data available for this plant type',
        deviceId
      });
    }
    
    res.json({
      plantType,
      deviceId,
      data,
      deviceState: deviceStates[deviceId]
    });
  } catch (error) {
    console.error('Error in /sensor-data:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Data update endpoint
app.post('/update', (req, res) => {
  try {
    const { deviceId, data } = req.body;

    if (!deviceId || !data) {
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
        waterPump: false,
        nutrientPump: false,
        lastWatered: null,
        lastNutrients: null,
        lastUpdated: new Date().toISOString(),
        connectionStatus: 'connected',
        lastSeen: new Date().toISOString()
      };
    }

    // Process and store the data
    const processedData = {
      ...data,
      timestamp: new Date().toISOString(),
      deviceId
    };
    sensorData[deviceId] = processedData;

    // Update device state
    deviceStates[deviceId] = {
      ...deviceStates[deviceId],
      connectionStatus: 'connected',
      lastSeen: new Date().toISOString(),
      lastUpdated: new Date().toISOString()
    };

    // Store in historical data
    const plantType = devicePlantMap[deviceId] || 'unknown';
    if (!historicalData[plantType]) {
      historicalData[plantType] = [];
    }
    historicalData[plantType].push(processedData);
    
    // Keep only last 100 records
    if (historicalData[plantType].length > 100) {
      historicalData[plantType] = historicalData[plantType].slice(-100);
    }

    // Emit to all clients
    io.emit('dataUpdate', {
      deviceId,
      plantType,
      data: processedData,
      state: deviceStates[deviceId]
    });

    res.json({ 
      status: 'success',
      deviceId,
      plantType,
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

// Command endpoint
app.post('/send-command', (req, res) => {
  try {
    const { deviceId, command, value, duration } = req.body;
    
    if (!deviceId || !command) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['deviceId', 'command'],
        received: Object.keys(req.body)
      });
    }

    if (!Object.values(COMMAND_TYPES).includes(command)) {
      return res.status(400).json({
        error: 'Invalid command type',
        validCommands: Object.values(COMMAND_TYPES)
      });
    }

    const commandObj = {
      id: Date.now().toString(),
      command,
      value: value !== undefined ? value : 1,
      deviceId,
      plantType: devicePlantMap[deviceId],
      duration: duration || 3000,
      timestamp: new Date().toISOString(),
      status: COMMAND_STATUS.PENDING,
      issuedBy: req.ip
    };

    if (!pendingCommands[deviceId]) {
      pendingCommands[deviceId] = [];
    }
    pendingCommands[deviceId].push(commandObj);

    // Update device state
    if (command === COMMAND_TYPES.LIGHT_ON || command === COMMAND_TYPES.LED || command === COMMAND_TYPES.GROW_LIGHT) {
      deviceStates[deviceId].light = true;
    } else if (command === COMMAND_TYPES.LIGHT_OFF) {
      deviceStates[deviceId].light = false;
    } else if (command === COMMAND_TYPES.WATER_PLANT || command === COMMAND_TYPES.WATER_PUMP) {
      deviceStates[deviceId].waterPump = true;
      deviceStates[deviceId].lastWatered = new Date().toISOString();
    } else if (command === COMMAND_TYPES.ADD_NUTRIENTS || command === COMMAND_TYPES.FERT_PUMP || command === COMMAND_TYPES.NUTRIENT_PUMP) {
      deviceStates[deviceId].nutrientPump = true;
      deviceStates[deviceId].lastNutrients = new Date().toISOString();
    }

    // Emit to frontend
    io.emit('controlResponse', {
      action: command,
      deviceId,
      plantType: commandObj.plantType,
      success: true,
      active: true,
      message: `${command} command issued`,
      timestamp: new Date().toISOString()
    });

    // Send to device
    io.to(`device_${deviceId}`).emit('executeCommand', {
      command,
      value: commandObj.value,
      duration: commandObj.duration
    });

    // Set timeout
    const timeout = setTimeout(() => {
      const cmdIndex = pendingCommands[deviceId].findIndex(c => c.id === commandObj.id);
      if (cmdIndex !== -1 && pendingCommands[deviceId][cmdIndex].status === COMMAND_STATUS.PENDING) {
        pendingCommands[deviceId][cmdIndex].status = COMMAND_STATUS.TIMEOUT;
        pendingCommands[deviceId][cmdIndex].timeoutAt = new Date().toISOString();
        
        io.emit('controlResponse', {
          action: command,
          deviceId,
          success: false,
          message: `${command} command timed out`,
          timestamp: new Date().toISOString()
        });
      }
    }, 5 * 60 * 1000); // 5 minutes
    
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
      message: error.message
    });
  }
});

// Debug endpoints
app.get('/debug/connections', (req, res) => {
  res.json({
    connections: io.engine.clientsCount,
    sockets: Array.from(io.sockets.sockets.keys())
  });
});

app.get('/debug/data', (req, res) => {
  res.json({
    sensorData,
    deviceStates,
    pendingCommands
  });
});

app.get('/debug/devices', (req, res) => {
  res.json({
    devices: deviceStates,
    mapping: devicePlantMap
  });
});

// WebSocket connection handling
io.on('connection', (socket) => {
  const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  console.log(`📡 New client connected [${socket.id}] from ${clientIp}`);

  // Send initial data
  const initData = { 
    sensorData,
    deviceStates,
    reservoirLevels: {
      water: sensorData['esp32_1']?.waterLevel || 75,
      waterCm: Math.round((sensorData['esp32_1']?.waterLevel || 75) * 0.2),
      fertilizer: sensorData['esp32_2']?.fertilizerLevel || 60,
      fertilizerCm: Math.round((sensorData['esp32_2']?.fertilizerLevel || 60) * 0.2)
    },
    pendingCommands: Object.keys(pendingCommands).reduce((acc, key) => {
      acc[key] = pendingCommands[key].filter(cmd => cmd.status === COMMAND_STATUS.PENDING);
      return acc;
    }, {}),
    timestamp: new Date().toISOString()
  };
  
  socket.emit('initData', initData);

  // Device connection handler
  socket.on('deviceConnect', (deviceId) => {
    if (devicePlantMap[deviceId]) {
      socket.join(`device_${deviceId}`);
      deviceStates[deviceId].connectionStatus = 'connected';
      deviceStates[deviceId].lastSeen = new Date().toISOString();
      
      io.emit('deviceStatusUpdate', {
        deviceId,
        status: 'connected',
        timestamp: new Date().toISOString()
      });
    }
  });

  // Data request handler
  socket.on('requestInitialData', (data) => {
    const { deviceId } = data;
    const responseData = {
      sensorData: deviceId ? { [deviceId]: sensorData[deviceId] } : sensorData,
      deviceStates: deviceId ? { [deviceId]: deviceStates[deviceId] } : deviceStates,
      timestamp: new Date().toISOString()
    };
    socket.emit('initData', responseData);
  });

  socket.on('disconnect', (reason) => {
    console.log(`❌ Client disconnected [${socket.id}]: ${reason}`);
  });

  socket.on('error', (error) => {
    console.error(`[${socket.id}] Socket error:`, error);
  });
});

// Simulate data updates for testing
setInterval(() => {
  Object.keys(sensorData).forEach(deviceId => {
    if (sensorData[deviceId]) {
      const data = sensorData[deviceId];
      const newData = {
        ...data,
        temperature: Math.max(15, Math.min(30, data.temperature + (Math.random() - 0.5) * 0.5)),
        humidity: Math.max(30, Math.min(90, data.humidity + (Math.random() - 0.5) * 2)),
        moisture: Math.max(0, Math.min(100, data.moisture + (Math.random() - 0.5) * 3)),
        timestamp: new Date().toISOString()
      };
      
      sensorData[deviceId] = newData;
      
      const plantType = devicePlantMap[deviceId];
      io.emit('dataUpdate', {
        deviceId,
        plantType,
        data: newData,
        state: deviceStates[deviceId]
      });
    }
  });
}, 30000); // Every 30 seconds

// Cleanup old data
setInterval(() => {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  
  // Cleanup pending commands
  Object.keys(pendingCommands).forEach(deviceId => {
    pendingCommands[deviceId] = pendingCommands[deviceId].filter(command => {
      const shouldKeep = new Date(command.timestamp) > oneHourAgo || 
                       command.status === COMMAND_STATUS.PENDING;
      if (!shouldKeep && command.timeoutRef) {
        clearTimeout(command.timeoutRef);
      }
      return shouldKeep;
    });
  });
  
  // Update device connection status
  Object.keys(deviceStates).forEach(deviceId => {
    if (deviceStates[deviceId].lastSeen && 
        new Date(deviceStates[deviceId].lastSeen) < oneHourAgo) {
      deviceStates[deviceId].connectionStatus = 'disconnected';
    }
  });
}, 30 * 60 * 1000); // Every 30 minutes

// Start server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 HTTP: http://localhost:${PORT}`);
  console.log(`⚡ WebSocket: ws://localhost:${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
